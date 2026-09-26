/**
 * Harness snapshot debug route.
 *
 * Answers the question: "what would the client compute right now for this
 * conversation if it loaded fresh?" — without needing a browser, devtools, or
 * a reproduction screen-recording.
 *
 * Motivated by cold-load/hydration visual bugs (see memory
 * `reference_lattice_hydration_gates.md`): the derived client state
 * (deriveStatus / hydrationPhase / background tasks) is computed from the raw
 * event log, but is only visible in the browser at runtime. Pulling the raw
 * event log and running the same derivations server-side makes those values
 * inspectable from the terminal and collapses most visual-bug investigations
 * into a single curl.
 *
 * This route intentionally duplicates the harness's `derive*` functions on
 * the server. The derivations are pure functions of the event log; the
 * duplication is acceptable because the route is advisory/observational and
 * the alternative (piping through the browser) defeats the purpose.
 */

import { Router, type Request, type Response } from 'express';
import {
  deriveStatus,
  deriveProcessAlive,
  deriveBackgroundTasks,
  hasRunningBackgroundTasks,
  deriveUsage,
} from '@liggi/agent-ui-harness/protocol';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { getEventStorage } from '@/harness/event-message-reader.js';
import { asyncHandler } from '@/middleware/error-handler.js';
import { parsePositiveIntQuery } from '@/utils/query-helpers.js';
import type { DebugRouteContext } from './debug-route-utils.js';

interface EventPreview {
  seq: number;
  type: string;
  runId: string;
  timestamp: number;
  timestampIso: string;
  dataPreview?: string;
}

interface HarnessSnapshot {
  sessionId: string;
  checkedAt: string;
  totalEvents: number;
  firstSeq: number | null;
  lastSeq: number | null;
  firstEventAt: string | null;
  lastEventAt: string | null;
  eventTypeCounts: Record<string, number>;

  derived: {
    status: string;
    statusStoppedAtEvent: {
      seq: number;
      type: string;
      offsetFromEnd: number;
    } | null;
    processAlive: boolean;
    hasBackgroundTasks: boolean;
    backgroundTasks: Array<{
      taskId: string;
      toolUseId: string;
      taskType: string;
      description?: string;
      status: 'running' | 'completed';
    }>;
    usage: ReturnType<typeof deriveUsage> | null;
  };

  /**
   * What the client would reasonably see on a cold load. The actual client
   * receives scoped replay + backfill; this is the steady-state "everything is
   * hydrated" projection. Useful for ruling out derivation-layer bugs.
   */
  coldLoadProjection: {
    wouldDeriveStatus: string;
    wouldDeriveProcessAlive: boolean;
    expectedLatticeStatusAfterHydration: 'idle' | 'initializing' | 'streaming' | 'stopping';
    expectedIsStreamingAfterHydration: boolean;
  };

  /** Tail of the raw event log. */
  recentEvents: EventPreview[];
}

export function createDebugHarnessSnapshotRoutes(_context: DebugRouteContext): Router {
  const router = Router();

  /**
   * GET /api/debug/sessions/:sessionId/harness-snapshot
   *
   * Query params:
   *   limit: max recent events returned (default 40)
   */
  router.get(
    '/sessions/:sessionId/harness-snapshot',
    asyncHandler(async (req: Request, res: Response) => {
      const { sessionId } = req.params;
      const limit = parsePositiveIntQuery(req.query.limit, { defaultValue: 40 }) ?? 40;

      const storage = getEventStorage();
      const events = storage.read(sessionId);

      if (events.length === 0) {
        res.status(404).json({
          error: 'no_events',
          message: 'No harness events found for this session id',
          sessionId,
        });
        return;
      }

      const status = deriveStatus(events);
      const processAlive = deriveProcessAlive(events);
      const backgroundTasks = deriveBackgroundTasks(events);
      const hasBgTasks = hasRunningBackgroundTasks(events);
      const usage = deriveUsage(events);

      // Trace where deriveStatus stopped — useful for "why is status X".
      // Mirrors the switch in derive.ts; kept inline so the route has no
      // runtime dependency on harness internals beyond the exported functions.
      const statusStoppedAtEvent = (() => {
        for (let i = events.length - 1; i >= 0; i--) {
          const e = events[i];
          if (
            e.type === 'run:end' ||
            e.type === 'run:error' ||
            e.type === 'turn:end' ||
            e.type === 'stop:requested' ||
            e.type === 'content' ||
            e.type === 'result' ||
            e.type === 'input:sent'
          ) {
            return {
              seq: e.seq,
              type: e.type,
              offsetFromEnd: events.length - 1 - i,
            };
          }
        }
        return null;
      })();

      // Event type counts
      const eventTypeCounts: Record<string, number> = {};
      for (const e of events) {
        eventTypeCounts[e.type] = (eventTypeCounts[e.type] || 0) + 1;
      }

      const tail: EventPreview[] = [];
      for (let i = events.length - 1; i >= 0 && tail.length < limit; i--) {
        tail.push(eventToPreview(events[i]));
      }
      tail.reverse();

      const expectedIsStreamingAfterHydration = status === 'streaming';
      const expectedLatticeStatusAfterHydration = mapStatusForProjection(status);

      const snapshot: HarnessSnapshot = {
        sessionId,
        checkedAt: new Date().toISOString(),
        totalEvents: events.length,
        firstSeq: events[0]?.seq ?? null,
        lastSeq: events[events.length - 1]?.seq ?? null,
        firstEventAt: events[0] ? new Date(events[0].timestamp).toISOString() : null,
        lastEventAt: events[events.length - 1]
          ? new Date(events[events.length - 1].timestamp).toISOString()
          : null,
        eventTypeCounts,
        derived: {
          status,
          statusStoppedAtEvent,
          processAlive,
          hasBackgroundTasks: hasBgTasks,
          backgroundTasks: Array.from(backgroundTasks.values()).map(t => ({
            taskId: t.taskId,
            toolUseId: t.toolUseId,
            taskType: t.taskType,
            description: t.description,
            status: t.status,
          })),
          usage,
        },
        coldLoadProjection: {
          wouldDeriveStatus: status,
          wouldDeriveProcessAlive: processAlive,
          expectedLatticeStatusAfterHydration,
          expectedIsStreamingAfterHydration,
        },
        recentEvents: tail,
      };

      res.json(snapshot);
    }),
  );

  return router;
}

function mapStatusForProjection(
  s: ReturnType<typeof deriveStatus>,
): 'idle' | 'initializing' | 'streaming' | 'stopping' {
  switch (s) {
    case 'idle':
      return 'idle';
    case 'starting':
      return 'initializing';
    case 'streaming':
      return 'streaming';
    case 'stopping':
      return 'stopping';
  }
}

function eventToPreview(e: SessionEvent): EventPreview {
  const preview: EventPreview = {
    seq: e.seq,
    type: e.type,
    runId: e.runId,
    timestamp: e.timestamp,
    timestampIso: new Date(e.timestamp).toISOString(),
  };
  const dp = buildDataPreview(e);
  if (dp) preview.dataPreview = dp;
  return preview;
}

function buildDataPreview(e: SessionEvent): string | undefined {
  try {
    const data = e.data as Record<string, unknown>;
    if (!data) return undefined;

    switch (e.type) {
      case 'content': {
        const blocks = data.blocks as Array<Record<string, unknown>> | undefined;
        if (!blocks) return undefined;
        return blocks
          .map(b => {
            const t = b.type as string;
            if (t === 'text') return `text(${truncate(b.text as string)})`;
            if (t === 'tool_use') return `tool_use(${b.name as string})`;
            if (t === 'thinking') return 'thinking';
            return t;
          })
          .join(', ');
      }
      case 'result': {
        const blocks = data.blocks as Array<Record<string, unknown>> | undefined;
        if (!blocks) return undefined;
        return blocks.map(b => (b.type as string) ?? 'unknown').join(', ');
      }
      case 'input:sent': {
        return `text(${truncate((data.text as string) ?? '')})`;
      }
      case 'task:started':
      case 'task:updated':
      case 'task:notification': {
        const taskId = data.taskId as string | undefined;
        return taskId ? `taskId=${taskId}` : undefined;
      }
      case 'turn:end': {
        const usage = data.usage as { inputTokens?: number; outputTokens?: number } | undefined;
        return usage ? `usage(in=${usage.inputTokens ?? 0},out=${usage.outputTokens ?? 0})` : undefined;
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function truncate(s: string, max = 80): string {
  if (!s) return '';
  if (s.length <= max) return s.replace(/\n/g, ' ');
  return `${s.slice(0, max).replace(/\n/g, ' ')}…`;
}
