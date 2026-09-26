/**
 * Idle-session reaper — retires keep-alive CLI processes that have sat idle.
 *
 * Keep-alive mode holds each session's CLI process alive between turns so a
 * follow-up message skips the spawn + resume cost. That's the right trade for
 * minutes, not hours: every resident claude/codex process costs 100-400MB and
 * a steady trickle of CPU.
 *
 * Who else ends these processes, and who doesn't:
 * - Sessions on the daemon path (DaemonProcessAdapter) already have a backstop.
 *   ProcessDaemon arms a per-process idle timer when a turn's result arrives
 *   and kills the CLI after IDLE_TIMEOUT_MS — 5 minutes, see
 *   process-daemon.ts:155. For those the reaper is a redundant second net that
 *   fires much later.
 * - Sessions on the in-server adapters — CodexProcessAdapter,
 *   OpencodeProcessAdapter — have no such timer. Those processes are children
 *   of lattice-server and live until the session is explicitly stopped or the
 *   server restarts. The reaper is the only thing that ends them, so it is
 *   load-bearing for that population: a day of normal use otherwise accumulates
 *   idle processes that survive until the next restart.
 *
 * Stopping an idle process is safe by construction: it is exactly the state
 * every session is in after a server restart, and the next message resumes the
 * conversation via --resume through the standard path. The event log records
 * run:end, so status honestly reports completed and the activity stream pushes
 * the transition to the sidebar.
 *
 * A session is only reaped when ALL hold:
 * - harness-derived status is idle (never mid-turn, starting, or stopping)
 * - no pending background work that would wake it without user input
 * - no compaction in flight
 * - idle longer than IDLE_REAP_AFTER_MS since its last status-bearing event
 * - not part of a team (team messages arrive without user input)
 */

import { getHarnessSessionManager } from '@/harness/setup.js';
import { getEventStorage } from '@/harness/event-message-reader.js';
import { deriveSessionStatusFromEvents } from '@/harness/derive-session-status.js';
import { createLogger } from '@/services/infrastructure/logger.js';
import { ConversationService } from '@/services/sessions/conversation-service.js';
import type { SessionInfoService } from '@/services/sessions/session-info-service.js';

const logger = createLogger('IdleSessionReaper');

export const IDLE_REAP_AFTER_MS = 30 * 60_000;
const STATUS_WINDOW_EVENTS = 200;

export interface IdleReapResult {
  examined: number;
  reaped: string[];
}

/** Injection seams for tests; production callers omit them. */
export interface IdleReapDeps {
  manager?: {
    getSessionIds(): string[];
    stop(sessionId: string): Promise<void>;
    inspect?(sessionId: string): { processAlive?: boolean } | null;
  } | null;
  storage?: {
    readStatusWindow(sessionId: string, limit: number): ReturnType<
      ReturnType<typeof getEventStorage>['readStatusWindow']
    >;
  } | null;
  getLatestSegmentProviderSessionId?: (conversationId: string) => string | undefined;
}

export async function reapIdleSessions(
  sessionInfoService: SessionInfoService,
  now: number = Date.now(),
  deps: IdleReapDeps = {},
): Promise<IdleReapResult> {
  const manager = deps.manager !== undefined ? deps.manager : getHarnessSessionManager();
  if (!manager) return { examined: 0, reaped: [] };

  const storage = deps.storage !== undefined ? deps.storage : (() => {
    try { return getEventStorage(); } catch { return null; }
  })();
  if (!storage) return { examined: 0, reaped: [] };

  const reaped: string[] = [];
  const sessionIds = manager.getSessionIds();

  for (const sessionId of sessionIds) {
    if (!sessionId.startsWith('conv-')) continue;

    // Nothing to retire when no CLI process is resident. Sessions recovered
    // from storage at startup are registered here but were never spawned, and
    // manager.stop() is a silent no-op for them (it returns early on
    // !process.alive). Counting that no-op as a reap made every sweep re-reap
    // the same recovered sessions forever: stop() appends no event, so their
    // idle age never resets and they re-qualify five minutes later.
    // Skipping here also avoids a readStatusWindow hit per dead session.
    // Guarded on inspect being present so injected test doubles that omit the
    // seam keep their existing behaviour.
    const diagnostics = manager.inspect?.(sessionId);
    if (diagnostics && !diagnostics.processAlive) continue;

    let events;
    try {
      events = storage.readStatusWindow(sessionId, STATUS_WINDOW_EVENTS);
    } catch (err) {
      logger.warn('Failed to read events for idle reap', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const derived = deriveSessionStatusFromEvents(events);
    if (derived.status !== 'idle') continue;
    if (derived.pendingWork) continue;
    if (derived.compacting) continue;

    const lastTimestamp = events.at(-1)?.timestamp;
    if (typeof lastTimestamp !== 'number' || !Number.isFinite(lastTimestamp)) continue;
    if (now - lastTimestamp < IDLE_REAP_AFTER_MS) continue;

    // Team sessions receive inbox messages without user input; an absent
    // process would silently miss them. team_name can live on either the
    // conversation row or the latest segment's row (mirrors the list route).
    const segmentSessionId = deps.getLatestSegmentProviderSessionId
      ? deps.getLatestSegmentProviderSessionId(sessionId)
      : ConversationService.getInstance().getLatestSegment(sessionId)?.providerSessionId ?? undefined;
    const info = sessionInfoService.getMergedSessionInfo(sessionId, segmentSessionId);
    if (info?.team_name) continue;

    try {
      await manager.stop(sessionId);
      reaped.push(sessionId);
      logger.info('Reaped idle keep-alive session', {
        sessionId,
        idleMinutes: Math.round((now - lastTimestamp) / 60_000),
      });
    } catch (err) {
      logger.warn('Failed to stop idle session', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { examined: sessionIds.length, reaped };
}
