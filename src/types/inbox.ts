/**
 * A session's inbox: what arrived while it could not read.
 *
 * A Codex process parks a mid-turn input in memory until its turn ends, and
 * a worker's report can only be handed to its coordinator between turns. Both
 * used to have their own durable queue with its own receipt states; now both
 * are rows in one table (`session_inbox`, see
 * `src/services/sessions/session-inbox.ts`) that the server drains into one
 * turn when the session is idle. Attribution is the `source` column: a user's
 * message is never presented as a worker's report, and a message another
 * agent sent (`session send --from`) is never presented as the user's. The
 * `sender` on an agent item is what the sender declared, not proof of who
 * wrote it; an agent that declared nothing is `agent` with no sender, and is
 * shown to the model as unidentified rather than as anyone in particular.
 *
 * The thread sees two events, appended to the session's own log:
 *
 *   `input:queued { id, source, text, blocks?, worker?, sender?, passedOn?, sourceSeq? }`
 *                                                 the item is in the inbox
 *   `input:read   { ids }`                        a turn has taken these items;
 *                                                 appended right after the
 *                                                 `input:sent` that carried them
 *   `input:withdrawn { ids }`                     taken back unread; never delivered
 *
 * A user item is shown as the user's bubble, "queued" until it is read, then
 * at the point the turn took it. Worker items are not shown at all: the
 * worker event (`worker:reported` / `worker:asked`) already carries them in
 * their own shape. The `input:sent` a drain produces is the batch the model
 * saw, so it is hidden too; the transcript still has it.
 *
 * Logs from before the inbox carry `input:queued { id }` with no `source`
 * (paired to the `input:sent` just before it) and `input:resent { id }` for a
 * restart's copy of an earlier message; the fold keeps hiding those copies.
 */

import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { INPUT_DELIVERED_EVENT, type InputDeliveredData } from './immediate-delivery.js';

/**
 * `user`: the user, from the composer. `agent`: another conversation, by
 * `session send --from` (or with no declaration at all). `worker-report` and
 * `worker-question`: a dispatched worker's turn-ending message, delivered by
 * the server. `coordination-review`: the server's own orientation review of
 * a coordinator's project (see `coordination-review.ts`). `reaction`: the user put an emoji on (or
 * took one off) one of the session's messages, as one attributed line
 * (see `message-reactions.ts`); the thread shows it as the reaction, not as
 * a message. `worker-stopped`: the user pressed Stop on one of the
 * coordinator's workers, as one attributed line in place of a report (see
 * `worker-report-delivery.ts`). `worker-permission`: a worker's permission
 * prompt for the coordinator to decide (see `worker-permission-delivery.ts`).
 * `decision`: the user's answer to the session's own question (`lattice ask`,
 * see `decisions.ts`), as one attributed line. The thread shows the answer as
 * the user's message from its `decision:answered` event, not from this item.
 * `explain`: the user finished the session's own explain-back (`lattice
 * explain`, see `explain-back.ts`), as one attributed line; the thread shows
 * the card, not this item.
 * `dismissal`: the user dismissed one of a coordinator's threads from the
 * panel, or brought one back (see `thread-dismissal.ts`), as one attributed
 * line; the thread shows it from the park note, not from this item.
 * Logs from before 2026-09-26 may also hold `quick-answer` items from a
 * removed feature; the thread skips them like any source it does not show.
 */
export type InboxSource = 'user' | 'agent' | 'worker-report' | 'worker-question' | 'coordination-review' | 'reaction' | 'worker-stopped' | 'worker-permission' | 'decision' | 'explain' | 'dismissal';

export const INBOX_QUEUED_EVENT = 'input:queued';
export const INBOX_READ_EVENT = 'input:read';
/** A drain could not hand the items to a turn; the thread says so on the bubble until a later drain reads them. */
export const INBOX_UNDELIVERABLE_EVENT = 'input:undeliverable';
/** Items taken back before any turn read them (a reaction removed in time); they were never delivered. */
export const INBOX_WITHDRAWN_EVENT = 'input:withdrawn';

export interface InboxQueuedData {
  id: string;
  source: InboxSource;
  /** The user's message as written, or the worker's turn text. */
  text: string;
  /** The attachments sent with it (images, documents), as the `input:sent` that carries it will hold them. */
  blocks?: Array<Record<string, unknown>>;
  worker?: string;
  /** For `agent`: the conversation that declared itself the sender; absent when none did. */
  sender?: string;
  /** The sender declared the text relays the user's decision (`--passed-on`). */
  passedOn?: boolean;
  /** The event in this session's log the item was made from (worker:asked, worker:reported, coordination:review). */
  sourceSeq?: number;
  /** The sender asked for it to wait for the running turn to end (`send --after-turn`). */
  afterTurn?: boolean;
}

export interface InboxReadData {
  ids: string[];
  /**
   * The `input:sent` these items went out on. A drain appends its receipt
   * immediately after its own send, so it can leave this out; a delivery into
   * a running turn learns that a turn took the items later, by which time
   * another `input:sent` may have been appended, and "the most recent one" is
   * no longer the right answer.
   */
  sentSeq?: number;
}

export interface InboxWithdrawnData {
  ids: string[];
}

export interface InboxUndeliverableData {
  ids: string[];
  error: string;
}

export interface InboxItem {
  id: string;
  source: InboxSource;
  text: string;
  worker: string | null;
  /** Declared sender of an `agent` item; null when undeclared or not an agent item. */
  sender: string | null;
  passedOn: boolean;
  sourceSeq: number | null;
  /** The `input:queued` event (or, for a pre-inbox log, the `input:sent`) that shows this item. */
  event: SessionEvent;
  /** Seq of the `input:sent` whose turn read this item; null while it waits. */
  readBySeq: number | null;
  /** Set by the latest failed drain since it was queued. */
  undeliverable: string | null;
  /** The `input:read` event: where the session took this item in. Null while it waits. */
  readEvent: SessionEvent | null;
  /** From a pre-inbox log: shown by its own `input:sent`, not by the queued event. */
  legacy: boolean;
}

export interface InboxFold {
  items: InboxItem[];
  /** `input:sent` seqs that carried a drain batch or a restart copy: not shown as messages. */
  hiddenInputSeqs: ReadonlySet<number>;
}

/** Fold the inbox events in a session's log into items with their read state. */
export function foldInbox(events: readonly SessionEvent[]): InboxFold {
  const items = new Map<string, InboxItem>();
  const hiddenInputSeqs = new Set<number>();
  let unpairedInputSeq: number | null = null;
  let unpairedInput: SessionEvent | null = null;

  for (const event of events) {
    switch (event.type as string) {
      case 'input:sent': {
        const data = event.data as { source?: string };
        if (data.source === 'command') break;
        unpairedInputSeq = event.seq;
        unpairedInput = event;
        break;
      }
      case INBOX_QUEUED_EVENT: {
        const data = event.data as Partial<InboxQueuedData>;
        if (!data.id) break;
        if (data.source) {
          items.set(data.id, {
            id: data.id,
            source: data.source,
            text: data.text ?? '',
            worker: data.worker ?? null,
            sender: data.sender ?? null,
            passedOn: data.passedOn === true,
            sourceSeq: typeof data.sourceSeq === 'number' ? data.sourceSeq : null,
            event,
            readBySeq: null,
            undeliverable: null,
            readEvent: null,
            legacy: false,
          });
          break;
        }
        if (unpairedInputSeq === null || !unpairedInput) break;
        items.set(data.id, {
          id: data.id,
          source: 'user',
          text: (unpairedInput.data as { text?: string }).text ?? '',
          worker: null,
          sender: null,
          passedOn: false,
          sourceSeq: null,
          event: unpairedInput,
          readBySeq: null,
          undeliverable: null,
          readEvent: null,
          legacy: true,
        });
        unpairedInputSeq = null;
        break;
      }
      case 'input:resent': {
        if (unpairedInputSeq === null) break;
        hiddenInputSeqs.add(unpairedInputSeq);
        unpairedInputSeq = null;
        break;
      }
      case INBOX_READ_EVENT: {
        const { ids, sentSeq } = event.data as Partial<InboxReadData>;
        const readBy: number | null = typeof sentSeq === 'number' ? sentSeq : unpairedInputSeq;
        if (!ids || readBy === null) break;
        for (const id of ids) {
          const item = items.get(id);
          if (!item || item.readBySeq !== null) continue;
          item.readBySeq = readBy;
          item.readEvent = event;
          item.undeliverable = null;
        }
        // The batch is hidden even when its items are outside the loaded
        // window: they are shown by their own queued events, not by it.
        hiddenInputSeqs.add(readBy);
        if (readBy === unpairedInputSeq) unpairedInputSeq = null;
        break;
      }
      // A batch sent into the running turn. Its `input:sent` is the batch,
      // not a message, so it is hidden now rather than when a turn takes it:
      // until then it would show as a second copy of the queued item (Claude
      // takes it only once its running tool finishes). Events from before
      // `sentSeq` was recorded follow their `input:sent` directly.
      case INPUT_DELIVERED_EVENT: {
        const { status, sentSeq } = event.data as Partial<InputDeliveredData>;
        if (status === 'rejected') break;
        const carried: number | null = typeof sentSeq === 'number' ? sentSeq : unpairedInputSeq;
        if (carried !== null) hiddenInputSeqs.add(carried);
        if (carried === unpairedInputSeq) unpairedInputSeq = null;
        break;
      }
      case INBOX_UNDELIVERABLE_EVENT: {
        const { ids, error } = event.data as Partial<InboxUndeliverableData>;
        if (!ids) break;
        for (const id of ids) {
          const item = items.get(id);
          if (item && item.readBySeq === null) item.undeliverable = error ?? 'not delivered';
        }
        break;
      }
      case INBOX_WITHDRAWN_EVENT: {
        const { ids } = event.data as Partial<InboxWithdrawnData>;
        for (const id of ids ?? []) {
          if (items.get(id)?.readBySeq === null) items.delete(id);
        }
        break;
      }
      default:
        break;
    }
  }

  return { items: [...items.values()], hiddenInputSeqs };
}

/**
 * What one session has been sent and has not taken into a turn yet. Queued
 * and read are the only two states here: a read item is one a turn was handed,
 * which is not evidence the session understood or acted on it.
 */
export interface UnreadInboxSummary {
  /** Items queued for the session with no turn having read them. */
  count: number;
  /** When the oldest of them was queued, ms since the epoch. */
  oldestAt: number;
  /** How many of them the asking conversation sent itself; the rest are the user's or another session's. */
  fromYou: number;
}
