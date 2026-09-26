/**
 * A coordinator's recent thread as text, for anything that answers on its
 * behalf while it is busy (the router and the fast responder,
 * `coordinator-fast-reply.ts`). The user's messages, the coordinator's own
 * text, worker dispatches, answers and reports, in order, as the thread
 * shows them: server-written blocks (restore, nudge, worker headers) are
 * stripped or reduced to the line the thread shows.
 */

import { userName } from '../user-profile.js';
import {
  COORDINATOR_REPLIED_EVENT,
  type CoordinatorRepliedData,
} from '../../types/coordinator-reply.js';
import {
  isWorkerInput,
  stripContextRestore,
  stripPreamble,
  stripWorkerQuestionMarker,
  type WorkerAnsweredData,
  type WorkerAskedData,
  type WorkerReportedData,
  type WorkerStartedData,
  type WorkerReassignedData,
  type WorkerMovedData,
} from '../../types/worker-events.js';
import { INBOX_QUEUED_EVENT, foldInbox, type InboxQueuedData } from '../../types/inbox.js';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';

export interface ThreadEventLike {
  seq: number;
  type: string;
  timestamp: number;
  data: unknown;
}

export interface ThreadEntry {
  seq: number;
  at: number;
  who: 'user' | 'coordinator' | 'worker' | 'fast responder';
  text: string;
}

function clock(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 5);
}

/** The thread's entries, oldest first. */
export function foldThread(events: readonly ThreadEventLike[]): ThreadEntry[] {
  const entries: Array<ThreadEntry & { messageId?: string }> = [];
  // A drained batch's `input:sent` carries items the thread already shows
  // by their queued events, so it is not repeated (same fold as the client).
  const { hiddenInputSeqs } = foldInbox(events as readonly SessionEvent[]);
  for (const event of events) {
    switch (event.type) {
      case 'input:sent': {
        if (hiddenInputSeqs.has(event.seq)) break;
        const data = event.data as { text?: string; source?: string };
        if (data.source === 'command' || typeof data.text !== 'string') break;
        const text = stripPreamble(stripContextRestore(data.text));
        // A worker delivery is in the thread as its own worker event.
        if (!text || isWorkerInput(text)) break;
        entries.push({ seq: event.seq, at: event.timestamp, who: 'user', text });
        break;
      }
      case INBOX_QUEUED_EVENT: {
        const data = event.data as Partial<InboxQueuedData>;
        if (data.source !== 'user' || !data.id || typeof data.text !== 'string') break;
        entries.push({ seq: event.seq, at: event.timestamp, who: 'user', text: data.text });
        break;
      }
      case 'content': {
        const data = event.data as { blocks?: Array<{ type?: string; text?: string }>; parentToolUseId?: string | null; messageId?: string };
        if (data.parentToolUseId || !Array.isArray(data.blocks)) break;
        const text = data.blocks
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text as string)
          .join('\n');
        if (!text) break;
        // Codex streams one message as a content event per token, all with
        // the message's id; they are one entry, joined as the thread joins
        // them, spaces and all.
        const previous = entries[entries.length - 1];
        if (data.messageId && previous?.who === 'coordinator' && previous.messageId === data.messageId) {
          previous.text += text;
          break;
        }
        entries.push({ seq: event.seq, at: event.timestamp, who: 'coordinator', text, messageId: data.messageId });
        break;
      }
      case COORDINATOR_REPLIED_EVENT: {
        const data = event.data as Partial<CoordinatorRepliedData>;
        if (typeof data.text !== 'string') break;
        entries.push({ seq: event.seq, at: event.timestamp, who: 'fast responder', text: data.text });
        break;
      }
      case 'worker:started': {
        const data = event.data as WorkerStartedData;
        entries.push({
          seq: event.seq,
          at: event.timestamp,
          who: 'coordinator',
          text: data.movedFrom
            ? `(took over worker ${data.worker} from ${data.movedFrom.project ?? data.movedFrom.coordinator}: ${data.task})`
            : `(dispatched worker ${data.worker}: ${data.task})`,
        });
        break;
      }
      case 'worker:moved': {
        const data = event.data as WorkerMovedData;
        entries.push({ seq: event.seq, at: event.timestamp, who: 'coordinator', text: `(moved worker ${data.worker} to ${data.project ?? data.to}: ${data.task})` });
        break;
      }
      case 'worker:asked': {
        const data = event.data as WorkerAskedData;
        entries.push({ seq: event.seq, at: event.timestamp, who: 'worker', text: `${data.worker} asked: ${stripWorkerQuestionMarker(data.text)}` });
        break;
      }
      case 'worker:reassigned': {
        const data = event.data as WorkerReassignedData;
        entries.push({ seq: event.seq, at: event.timestamp, who: 'coordinator', text: `(moved worker ${data.worker} on to: ${data.task})` });
        break;
      }
      case 'worker:answered': {
        const data = event.data as WorkerAnsweredData;
        entries.push({
          seq: event.seq,
          at: event.timestamp,
          who: 'coordinator',
          text: `(answered worker ${data.worker}${data.passedOn ? `, passing on ${userName()}'s decision` : ''}: ${data.summary ?? data.text})`,
        });
        break;
      }
      case 'worker:reported': {
        const data = event.data as WorkerReportedData;
        entries.push({ seq: event.seq, at: event.timestamp, who: 'worker', text: `${data.worker} reported: ${data.text}` });
        break;
      }
      default:
        break;
    }
  }
  return entries.flatMap(({ messageId: _messageId, ...entry }) => {
    const text = entry.text.trim();
    return text ? [{ ...entry, text }] : [];
  });
}

/**
 * The last `turns` of the thread as text. A turn is one of the user's messages
 * and everything up to the next one, so the count is in exchanges rather
 * than lines. Nothing inside a kept turn is shortened.
 */
export function renderRecentThread(events: readonly ThreadEventLike[], turns: number): string {
  const entries = foldThread(events);
  let start = entries.length;
  let seen = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].who === 'user') {
      seen += 1;
      start = i;
      if (seen >= turns) break;
    }
  }
  const kept = entries.slice(Math.min(start, entries.length));
  if (kept.length === 0) return '(nothing in the thread yet)';
  return kept.map((entry) => `[${entry.who === 'user' ? userName() : entry.who} · ${clock(entry.at)}]\n${entry.text}`).join('\n\n');
}

/** The input fields that say what a tool call is doing, in the order tried. */
const TOOL_CALL_SUBJECT_FIELDS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'skill'] as const;

/**
 * What the coordinator has run in its current turn, as one line per tool
 * call: the time, the tool and what it was pointed at (a command, a file, a
 * pattern), never its output. The turn is everything since the last
 * `turn:end`; input delivered into it while it runs does not start a new one.
 */
export function renderCurrentTurnActivity(events: readonly ThreadEventLike[]): string {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'turn:end') {
      start = i + 1;
      break;
    }
  }
  const turn = events.slice(start);
  if (!turn.some((event) => event.type === 'input:sent')) return '(front is not in a turn: its last one has ended)';
  const lines: string[] = [];
  for (const event of turn) {
    if (event.type !== 'content') continue;
    const data = event.data as { blocks?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }>; parentToolUseId?: string | null };
    if (data.parentToolUseId || !Array.isArray(data.blocks)) continue;
    for (const block of data.blocks) {
      if (block.type !== 'tool_use') continue;
      const field = TOOL_CALL_SUBJECT_FIELDS.find((key) => typeof block.input?.[key] === 'string');
      const subject = field ? `: ${block.input?.[field] as string}` : '';
      lines.push(`[${clock(event.timestamp)}] ${block.name ?? 'tool'}${subject}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : '(no tool calls yet in this turn)';
}
