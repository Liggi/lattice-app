/**
 * Event side effects — dispatches non-persistence side effects for harness events.
 *
 * This is the onEvent callback passed to SessionManager. Persistence is handled
 * by the harness's own EventLog + SqliteEventStorageAdapter. This callback only
 * handles side effects that must fire in response to specific event types:
 *
 * - run:ready → update conversation segment with the real provider session ID
 * - input:sent / task:notification / run:ready → push session-started to SSE
 *   listeners (each is a way a turn can begin: a send, a background task
 *   finishing, a scheduled-wakeup revival)
 * - turn:end → push session-idle to SSE listeners (session-started when a
 *   message held through a compaction begins its own turn there)
 * - turn:end → trigger insights recomputation
 * - turn:end → deliver a worker's final message to the coordinator it was picked up from
 * - content / input:sent / turn:end / stop:requested → reassess what a worker is doing, for its card
 * - turn:end → compact the session if its context is over the threshold
 * - turn:end / run:end / run:error → drain the session's inbox into its next turn
 * - turn:end → keep the conversation's hand-off record current
 * - run:end / run:error → push session-idle + flush the hand-off record
 * - run:end of reason process_lost → hold a carry-on note until the daemon is back
 * - context:compaction / task:started / task:updated → push session-status-changed
 *   (compacting and armed work change without a turn starting or ending)
 *
 * Status VALUES are derived from the event log everywhere (see
 * derive-session-status.ts); the registry holds no status state — these
 * side effects only forward event-driven pushes through its emitter.
 */

import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { createLogger } from '../services/infrastructure/logger.js';
import { InsightsEngine } from '../services/insights/insights-engine.js';
import { ConversationService } from '../services/sessions/conversation-service.js';
import { deliverWorkerReport } from '../services/sessions/worker-report-delivery.js';
import { noteWorkerActivity, noteWorkerRuntimeChange } from '../services/sessions/worker-activity.js';
import { drainInbox } from '../services/sessions/session-inbox.js';
import { noteRunEnd } from '../services/sessions/restart-carry-on.js';
import { settleHeldDeliveries } from '../services/sessions/held-delivery-settlement.js';
import { maybeAutoCompact } from '../services/sessions/context-compaction.js';
import { noteStatusChanged } from '../services/sessions/session-status-changes.js';
import { getHarnessSessionManager } from './setup.js';
import type { ActiveConversationRegistry } from '../services/process/active-conversation-registry.js';

const logger = createLogger('HarnessEventSideEffects');

/**
 * Creates the onEvent callback for SessionManager.
 */
export function createEventSideEffectsCallback(
  registry: ActiveConversationRegistry,
): (event: SessionEvent) => void {
  return (event: SessionEvent) => {
    switch (event.type) {
      case 'run:ready':
        handleRunReady(event, registry);
        // Each of run:ready / input:sent / task:notification is a way a turn
        // can begin: a fresh or respawned process booting, a user send, a
        // background task finishing. A ScheduledWakeup revival emits ONLY a
        // bare run:ready (no input:sent, no task:notification — verified in
        // the event log 2026-08-28 11:52, seq 5957), so all three must push.
        registry.notifyActive(event.sessionId);
        break;
      case 'input:sent':
      case 'task:notification': {
        registry.notifyActive(event.sessionId);
        noteWorkerActivity(event.sessionId);
        break;
      }
      // What a worker is doing changes as it calls tools and writes; the
      // service coalesces these into at most one assessment per gap.
      case 'content': {
        noteWorkerActivity(event.sessionId);
        break;
      }
      case 'stop:requested': {
        noteWorkerActivity(event.sessionId);
        // A stop changes what the card should say immediately, and the
        // assessment above may never run (it debounces, and gives up on a
        // worker that is not working). Ring the panel directly as well.
        noteWorkerRuntimeChange(event.sessionId);
        break;
      }
      case 'turn:end': {
        // A message held through a compaction starts its own turn as the
        // compaction's turn ends (deriveStatus reads the incorporation), so
        // that turn:end is not the session going idle.
        if (getHarnessSessionManager()?.inspect(event.sessionId)?.status === 'streaming') {
          registry.notifyActive(event.sessionId);
        } else {
          registry.notifyIdle(event.sessionId);
        }
        void InsightsEngine.getInstance().onTurnEnd(event.sessionId);
        void deliverWorkerReport(event.sessionId);
        noteWorkerActivity(event.sessionId);
        // The turn ended, so the worker is idle even if its process lives on.
        noteWorkerRuntimeChange(event.sessionId);
        // A compaction started here ends in its own turn:end, and the inbox
        // drains from that one; sending now would only park the batch.
        void maybeAutoCompact(event.sessionId).then((compacting) => {
          if (!compacting) return drainInbox(event.sessionId);
        });
        break;
      }
      // Compaction starting or finishing, and a background task, subagent or
      // workflow starting or finishing, move the sidebar between Compacting,
      // Waiting and Idle while no turn starts or ends to push it.
      case 'context:compaction':
      case 'task:started':
      case 'task:updated':
        noteStatusChanged(event.sessionId);
        break;
      case 'run:end':
      case 'run:error': {
        registry.notifyIdle(event.sessionId);
        // The worker's process is gone. Nothing in the coordinator's own log
        // records that, so without this its panel goes on showing whatever
        // the worker was last doing — which is how four cards sat at Working
        // with dead processes on 2026-09-21.
        noteWorkerRuntimeChange(event.sessionId);
        if (event.type === 'run:end') noteRunEnd(event);
        // With the process gone, a message it had queued but not started is
        // settled from the transcript before the drain looks for work.
        void settleHeldDeliveries(event.sessionId).then(() => drainInbox(event.sessionId));
        break;
      }
      default:
        break;
    }
  };
}

/**
 * Handle run:ready — update the conversation segment's provider session ID.
 *
 * When a conversation is created, the segment gets a placeholder `pending-*`
 * provider session ID. The real Claude session UUID arrives in the run:ready
 * event's resumeId field. Without this update, every server restart causes
 * a fresh Claude session (lost context) because the resume lookup finds
 * only the stale pending-* placeholder.
 */
function handleRunReady(
  event: SessionEvent,
  registry: ActiveConversationRegistry,
): void {
  const data = event.data as { resumeId?: string; model?: string };
  const resumeId = data.resumeId;
  if (!resumeId) return;

  try {
    const conversationService = ConversationService.getInstance();
    const updated = conversationService.updateSegmentProviderSessionId(
      event.sessionId,
      resumeId,
    );
    if (updated) {
      logger.info('Updated segment providerSessionId from run:ready', {
        conversationId: event.sessionId,
        providerSessionId: resumeId.slice(0, 8),
      });
    }

    // Persist the configured model so mid-session switches survive a later
    // lifecycle resume (which defaults to the segment's stored model).
    if (data.model && conversationService.updateLatestSegmentModel(event.sessionId, data.model)) {
      logger.info('Updated segment model from run:ready', {
        conversationId: event.sessionId,
        model: data.model,
      });
    }

    // Keep the registry's providerSessionId index in sync. Follow-up spawns
    // launch CC with --resume <oldUUID> and CC issues a fresh UUID in this
    // run:ready event. Without this update, byProviderSessionId points at the
    // stale old UUID, breaking control_request lookups keyed by the new one.
    const existing = registry.get(event.sessionId);
    if (existing && existing.segment.providerSessionId !== resumeId) {
      registry.updateSegment(event.sessionId, {
        ...existing.segment,
        providerSessionId: resumeId,
      });
      logger.info('Registry segment providerSessionId updated from run:ready', {
        conversationId: event.sessionId,
        providerSessionId: resumeId.slice(0, 8),
      });
    }
  } catch (err) {
    logger.warn('Failed to update segment providerSessionId', {
      conversationId: event.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
