/**
 * Delivering a message into the turn a session is already running.
 *
 * The ordinary path for a message that arrives mid-turn is a durable row that
 * waits for the turn to end. The user's preference is the opposite:
 * messages go in immediately and the model sorts out what to do with them,
 * because by the time a turn ends the work a message was about has been done.
 * Both providers can take input into a running turn — Codex `turn/steer`,
 * Claude a uuid-stamped `priority: "next"` message — and both were proved to
 * do it without disturbing the tool in the foreground.
 *
 * Three things shape the code more than the happy path does.
 *
 * **The batch is the inbox, not the message.** Sending only the new message
 * would put it in front of older ones the session has not read, so the model
 * would act on it without having been told what came before. The batch is
 * every ready row in arrival order, composed by the same composer the drain
 * uses, so provenance and attachments are identical whichever route carries
 * them. Rows whose sender asked them to wait for the turn to end
 * (`send --after-turn`) are not ready: a later message going in immediately passes them,
 * which is what the sender asked for, and they go at the turn boundary.
 *
 * **A reservation, not a flag.** Between choosing the rows and hearing back
 * from the provider the turn can end, and its end fires a drain. Marking the
 * rows read before the provider answers would claim a delivery that may not
 * have happened; leaving them alone lets the drain send the same batch again.
 * So they are reserved in the database first, which takes them out of the
 * drain, and the reservation moves as the provider answers.
 *
 * **Acceptance is not incorporation.** Claude acknowledges a queued message
 * in milliseconds and only folds it into a turn later — possibly the turn
 * that was running, possibly the one after. The acknowledgement is what the
 * sender's receipt is made of; the incorporation is what the thread's
 * `input:read` is made of, and they are written at different moments. A
 * provider that never answers has told us nothing at all: those rows stay
 * reserved, are never re-sent, and are settled by a person
 * (`resolveUncertainReservation`).
 */

import { randomUUID } from 'node:crypto';
import type { SessionManager, SteerStage } from '@liggi/agent-ui-harness/server';
import { ConfigService } from '../infrastructure/config-service.js';
import { createLogger } from '../infrastructure/logger.js';
import { appendCustomHarnessEvent } from '../../harness/harness-custom-events.js';
import { getHarnessSessionManager } from '../../harness/setup.js';
import { COMPACTION_STATE_EVENT_TYPES, compactingFromNewestFirst } from '../../harness/derive-session-status.js';
import { iterateEventsNewestFirst } from '../../session-history/repository.js';
import { INBOX_READ_EVENT, type InboxReadData } from '../../types/inbox.js';
import {
  INPUT_DELIVERED_EVENT,
  INPUT_INCORPORATED_EVENT,
  type ImmediateDeliveryStatus,
  type InputDeliveredData,
  type InputIncorporatedData,
} from '../../types/immediate-delivery.js';
import { latticeCli } from './pickup-prompts.js';
import {
  composeInboxInput,
  drainHeld,
  drainInbox,
  markInboxItemsRead,
  markInboxReservation,
  releaseInboxReservation,
  readAttachments,
  reserveInboxItems,
  unreadInboxItems,
} from './session-inbox.js';
import { withTurnAdmission, type TurnAdmission } from './turn-admission.js';
import { noteTurnStarted } from './session-status-changes.js';

const logger = createLogger('ImmediateDelivery');

/**
 * Whether messages go into a running turn at all. On unless the config sets
 * `messaging.immediateDelivery: false`; holding a message for the turn
 * boundary is otherwise a per-message choice (`send --after-turn`).
 */
export function immediateDeliveryEnabled(): boolean {
  try {
    return ConfigService.getInstance().getConfig().messaging?.immediateDelivery !== false;
  } catch {
    return true;
  }
}

export interface ImmediateDeliveryResult {
  status: ImmediateDeliveryStatus;
  reservationId: string;
  /** Rows in the batch: the new message plus whatever older ready rows went with it. */
  items: number;
  /** Why, when the provider refused or went quiet. */
  reason?: string;
  detail?: Record<string, unknown>;
}

/**
 * Send everything the session is ready to read into the turn it is running.
 * The caller must hold the session's turn admission for the whole call: that
 * is what stops a drain, an auto-compaction or an interrupting send opening a
 * turn boundary underneath the delivery.
 *
 * Never throws. Every outcome is a status the caller can put in a receipt.
 */
export async function deliverIntoRunningTurn(input: {
  sessionManager: SessionManager;
  sessionId: string;
  admission: TurnAdmission;
  /** The row the new message was written to; it must be in the batch. */
  inboxId: string;
}): Promise<ImmediateDeliveryResult> {
  const { sessionManager, sessionId, admission, inboxId } = input;
  if (admission.sessionId !== sessionId) {
    throw new Error(`admission for ${admission.sessionId} used to deliver to ${sessionId}`);
  }

  const reservationId = randomUUID();
  const rows = unreadInboxItems(sessionId, { runningTurn: true });
  if (!rows.some((row) => row.id === inboxId)) {
    // Something read or reserved the row between writing it and here. Not an
    // error: whoever took it owns delivering it.
    logger.info('Row was already taken by another delivery', { sessionId, inboxId });
    return { status: 'rejected', reservationId, items: 0, reason: 'The message was already taken by another delivery' };
  }

  const ids = rows.map((row) => row.id);
  let attachments: unknown[];
  try {
    attachments = readAttachments(rows);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: 'rejected', reservationId, items: ids.length, reason };
  }
  // A compaction holds the batch until it ends, so the note says that rather than describing a running turn.
  const compacting = compactingFromNewestFirst(iterateEventsNewestFirst(sessionId, COMPACTION_STATE_EVENT_TYPES));
  const text = composeInboxInput(rows, latticeCli(), { midTurn: true, compacting });
  // The latest choice wins, as it would have if each message had been sent on its own.
  const model = [...rows].reverse().find((row) => row.model)?.model ?? undefined;
  const reasoningEffort = [...rows].reverse().find((row) => row.reasoning_effort)?.reasoning_effort ?? undefined;

  // Reserved before the provider is asked, so a turn ending mid-call finds
  // nothing to drain.
  reserveInboxItems(ids, reservationId);

  // The `input:sent` these rows went out on. Known once the harness answers,
  // except on the late path below, where the send is only recorded when the
  // acknowledgement finally turns up.
  let sentSeq: number | undefined;
  let steerReturned = false;
  // Whether this delivery has already been answered as unacknowledged. An
  // incorporation after that point is genuinely late: the sender was told the
  // message might not have arrived, and it turns out it did. An incorporation
  // that merely arrives after `steer` returned is not late — that is the
  // ordinary Claude shape, where the acknowledgement is immediate and the turn
  // takes the message whenever it next reads input.
  let answeredUncertain = false;
  let recorded = false;
  let bufferedIncorporation: Extract<SteerStage, { kind: 'incorporated' }> | null = null;

  /**
   * A turn has taken the batch. This is the moment the thread may say the
   * items were read, and the moment the rows stop being reserved.
   */
  const recordIncorporation = (stage: Extract<SteerStage, { kind: 'incorporated' }>, late: boolean): void => {
    if (recorded) return;
    recorded = true;
    const read = appendCustomHarnessEvent(sessionManager, sessionId, INBOX_READ_EVENT, {
      ids,
      ...(sentSeq !== undefined ? { sentSeq } : {}),
    } satisfies InboxReadData);
    markInboxItemsRead(ids, read?.seq ?? null);
    appendCustomHarnessEvent(sessionManager, sessionId, INPUT_INCORPORATED_EVENT, {
      reservationId,
      where: stage.where,
      evidence: stage.evidence,
      ...(late ? { late: true } : {}),
    } satisfies InputIncorporatedData);
    logger.info('Batch was taken into a turn', { sessionId, reservationId, where: stage.where, late });
    if (stage.where === 'next-turn') noteTurnStarted(sessionId);
    // Anything that arrived while the delivery was unresolved was held out of
    // the drain by it (see `sessionHasDeliveryInFlight`); this is where it
    // becomes deliverable again.
    if (steerReturned) void drainInbox(sessionId);
  };

  const onStage = (stage: SteerStage): void => {
    try {
      switch (stage.kind) {
        case 'handed-over':
          // Past this point "nothing was delivered" is no longer a fact a
          // restart can rely on.
          markInboxReservation(reservationId, 'handed');
          return;
        case 'accepted':
          if (stage.late) {
            // `deliverIntoRunningTurn` already answered `uncertain` and the
            // rows are being held as unresolved. The acknowledgement settles
            // that: the batch did reach the provider, so the send is recorded
            // now and the hold becomes an ordinary in-flight delivery again.
            const sent = appendCustomHarnessEvent(sessionManager, sessionId, 'input:sent', { text });
            if (sent) sentSeq = sent.seq;
            answeredUncertain = true;
            logger.info('A delivery recorded as unacknowledged was acknowledged after all', { sessionId, reservationId });
          }
          markInboxReservation(reservationId, 'accepted');
          return;
        case 'incorporated':
          // Codex acknowledges and incorporates in the same call, so this can
          // arrive before the harness has told us which `input:sent` carried
          // the batch. Hold it until it has.
          if (!steerReturned && sentSeq === undefined) {
            bufferedIncorporation = stage;
            return;
          }
          recordIncorporation(stage, answeredUncertain);
          return;
      }
    } catch (err) {
      // A delivery must not fail because its bookkeeping did.
      logger.error('Recording a delivery stage failed', err instanceof Error ? err : new Error(String(err)), {
        sessionId,
        reservationId,
        stage: stage.kind,
      });
    }
  };

  const outcome = await sessionManager.steer(sessionId, {
    input: text,
    deliveryId: reservationId,
    ...(attachments.length > 0 || model || reasoningEffort
      ? {
          extra: {
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(model ? { model } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
          },
        }
      : {}),
    onStage,
  });

  if (outcome.status === 'accepted' && outcome.sentSeq !== undefined) sentSeq = outcome.sentSeq;
  steerReturned = true;
  if (bufferedIncorporation) {
    const buffered: Extract<SteerStage, { kind: 'incorporated' }> = bufferedIncorporation;
    bufferedIncorporation = null;
    recordIncorporation(buffered, false);
  }

  let result: ImmediateDeliveryResult;
  switch (outcome.status) {
    case 'accepted':
      logger.info('Batch delivered into a running turn', {
        sessionId, reservationId, items: ids.length, sources: rows.map((row) => row.source),
      });
      result = {
        status: 'delivered',
        reservationId,
        items: ids.length,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      };
      break;
    case 'rejected':
      releaseInboxReservation(reservationId);
      logger.info('Immediate delivery refused; the batch waits for a turn boundary', {
        sessionId, reservationId, items: ids.length, reason: outcome.reason,
      });
      result = { status: 'rejected', reservationId, items: ids.length, reason: outcome.reason };
      break;
    case 'uncertain':
      // Not released and not marked read: whether it arrived is unknown, and
      // both of the confident answers would be a claim nothing witnessed.
      answeredUncertain = true;
      markInboxReservation(reservationId, 'uncertain');
      logger.warn('Delivery was not acknowledged; the batch is held and will not be re-sent', {
        sessionId, reservationId, items: ids.length, reason: outcome.reason,
      });
      result = { status: 'uncertain', reservationId, items: ids.length, reason: outcome.reason };
      break;
  }

  appendCustomHarnessEvent(sessionManager, sessionId, INPUT_DELIVERED_EVENT, {
    inboxId,
    reservationId,
    items: result.items,
    ...(sentSeq !== undefined ? { sentSeq } : {}),
    status: result.status,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.detail ? { detail: result.detail } : {}),
  } satisfies InputDeliveredData);

  return result;
}

/**
 * Hand a row the server has just written to its session, now if the session
 * is mid-turn and can take it, at the turn boundary otherwise.
 *
 * This is the entry point for rows the server writes on its own account — a
 * worker's report, the user's reaction — rather than ones
 * that arrive through the send route with an admission already held. The
 * refusal is the signal: a session that is not in a turn cannot be steered,
 * and `deliverIntoRunningTurn` releases the batch when it says so, which is
 * exactly the state an ordinary drain expects to find.
 */
export async function handOverNow(sessionId: string, inboxId: string): Promise<void> {
  if (!immediateDeliveryEnabled()) {
    void drainInbox(sessionId);
    return;
  }
  try {
    await withTurnAdmission(sessionId, 'send', async (admission) => {
      const result = await deliverIntoRunningTurn({
        sessionManager: requireSessionManager(),
        sessionId,
        admission,
        inboxId,
      });
      if (result.status === 'rejected') await drainHeld(sessionId, admission);
    });
  } catch (err) {
    logger.error('Handing a row over failed; it stays in the inbox', err instanceof Error ? err : new Error(String(err)), {
      sessionId,
      inboxId,
    });
  }
}

function requireSessionManager(): SessionManager {
  const manager = getHarnessSessionManager();
  if (!manager) throw new Error('No harness session manager');
  return manager;
}
