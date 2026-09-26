/**
 * Runtime facts derivation from harness event streams (§1.4 harness_events).
 *
 * The harness event stream is the runtime authority. Every other source is
 * compared against this projection. Pure function over the event log.
 */

import {
  deriveStatus,
  deriveProcessAlive,
  deriveBackgroundTasks,
  deriveScheduledWakeup,
} from '@liggi/agent-ui-harness/protocol';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import type { RuntimeFacts, RuntimeFactSeq, RuntimePhase } from './types.js';

function summarizeSeq(events: readonly SessionEvent[]): RuntimeFactSeq {
  if (events.length === 0) {
    return {
      firstSeq: null,
      lastSeq: null,
      eventCount: 0,
      lastEventType: null,
      lastEventAtMs: null,
    };
  }
  const last = events[events.length - 1];
  return {
    firstSeq: events[0].seq,
    lastSeq: last.seq,
    eventCount: events.length,
    lastEventType: last.type,
    lastEventAtMs: last.timestamp,
  };
}

function hasOpenRun(events: readonly SessionEvent[]): boolean {
  let openRunIds = 0;
  const closed = new Set<string>();
  for (const e of events) {
    if (e.type === 'run:start') openRunIds += 1;
    else if (e.type === 'run:end' || e.type === 'run:error') {
      if (!closed.has(e.runId)) {
        closed.add(e.runId);
        openRunIds -= 1;
      }
    }
  }
  return openRunIds > 0;
}

function latestRunReadyResumeId(events: readonly SessionEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== 'run:ready') continue;
    const data = e.data as { resumeId?: string | null } | undefined;
    if (!data?.resumeId) return null;
    return data.resumeId;
  }
  return null;
}

function isRealResumeId(id: string | null): boolean {
  return typeof id === 'string' && id.length > 0 && !id.startsWith('pending-');
}

export function deriveRuntimeFactsFromHarnessEvents(
  conversationId: string,
  events: readonly SessionEvent[],
): RuntimeFacts {
  const seq = summarizeSeq(events);
  const observedAtMs = Date.now();

  if (events.length === 0) {
    return {
      source: 'harness_events',
      observedAtMs,
      ids: { conversationId, providerSessionId: null },
      seq,
      sessionKnown: false,
      hasEventHistory: false,
      phase: 'absent',
      hasOpenRun: false,
      processAlive: false,
      turnActive: false,
      canSubmit: false,
      canStop: false,
      awaitingPermission: false,
      awaitingQuestion: false,
      hasRunningBackgroundTasks: false,
      scheduledWakeupPending: false,
      resumeReady: false,
    };
  }

  const status = deriveStatus(events);
  const processAlive = deriveProcessAlive(events);

  const phase: RuntimePhase =
    status === 'starting'
      ? 'starting'
      : status === 'streaming'
        ? 'working'
        : status === 'stopping'
          ? 'stopping'
          : processAlive
            ? 'idle_alive'
            : 'idle_dead';

  const resumeId = latestRunReadyResumeId(events);
  const tasks = deriveBackgroundTasks(events);
  let runningTasks = false;
  for (const task of tasks.values()) {
    if (task.status === 'running') {
      runningTasks = true;
      break;
    }
  }

  return {
    source: 'harness_events',
    observedAtMs,
    ids: {
      conversationId,
      providerSessionId: resumeId,
    },
    seq,
    sessionKnown: true,
    hasEventHistory: true,
    phase,
    hasOpenRun: hasOpenRun(events),
    processAlive,
    turnActive: status === 'streaming',
    canSubmit: phase !== 'starting' && phase !== 'stopping',
    canStop: phase === 'starting' || phase === 'working' || phase === 'stopping',
    // Permission/question state is owned by separate trackers (PermissionTracker,
    // PendingQuestionService); the harness protocol does not emit lifecycle
    // events for them, so this source cannot know.
    awaitingPermission: null,
    awaitingQuestion: null,
    hasRunningBackgroundTasks: runningTasks,
    scheduledWakeupPending: deriveScheduledWakeup(events) != null,
    resumeReady: isRealResumeId(resumeId),
  };
}
