/**
 * The user's emoji reactions, delivered to the agent whose message they reacted to.
 *
 * A reaction is a short attributed line in the recipient's inbox, handed over
 * at its next input point like any other message (`handOverNow`); on an idle
 * agent that starts a turn. Who gets it:
 *
 *   the thread's own agent's message   → that agent ("your message")
 *   a worker's report in the thread    → the thread's agent, the coordinator,
 *                                        which decides what the reaction means
 *                                        for the work ("conv-X's report")
 *   a message another agent sent in    → the agent that sent it
 *
 * Taking a reaction off withdraws its row if no turn has read it yet, so the
 * agent never hears of it. Once it has been delivered, the agent is told it
 * was removed rather than left acting on it.
 *
 * The reaction itself is recorded in the thread's log (`reaction:added` /
 * `reaction:removed`, see `types/message-reactions.ts`), which is what the
 * page shows and what a toggle is checked against.
 */

import { getHarnessSessionManager } from '../../harness/setup.js';
import { appendCustomHarnessEvent } from '../../harness/harness-custom-events.js';
import { getEvents } from '../../session-history/repository.js';
import {
  AGENT_REACTION_EVENT,
  REACTION_ADDED_EVENT,
  REACTION_REMOVED_EVENT,
  foldAgentReactions,
  foldReactions,
  type AgentReactionData,
  type ReactionAddedData,
  type ReactionRemovedData,
} from '../../types/message-reactions.js';
import { INBOX_QUEUED_EVENT, INBOX_READ_EVENT, INBOX_WITHDRAWN_EVENT, foldInbox, type InboxQueuedData } from '../../types/inbox.js';
import { INPUT_DELIVERED_EVENT } from '../../types/immediate-delivery.js';
import { isWorkerInput, stripContextRestore, stripPreamble } from '../../types/worker-events.js';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { enqueueInboxItem, withdrawInboxItem } from './session-inbox.js';
import { handOverNow } from './immediate-delivery.js';
import { userName, UserName } from '../user-profile.js';

export interface ReactionRequest {
  /** The thread the user reacted in. */
  threadId: string;
  messageId: string;
  emoji: string;
  action: 'add' | 'remove';
  /** The message's first line, which is how the recipient recognises it. */
  excerpt: string;
  /** Set when the message is a worker's report in the thread. */
  worker?: string;
  /** Set when another session sent the message into the thread. */
  sender?: string;
}

export type ReactionOutcome =
  | { status: 'added'; recipient: string }
  | { status: 'removed'; recipient: string; withdrawn: boolean }
  /** Adding a reaction already there, or removing one that is not: nothing is sent. */
  | { status: 'unchanged' };

/** Who the line is about, as the recipient reads it. */
function describeMessage(request: ReactionRequest): string {
  const excerpt = `"${request.excerpt}"`;
  if (request.sender) return `the message you sent ${request.threadId}, ${excerpt}`;
  if (request.worker) return `${request.worker}'s report ${excerpt}`;
  return `your message ${excerpt}`;
}

export function reactionLine(request: ReactionRequest): string {
  return request.action === 'add'
    ? `${UserName()} reacted ${request.emoji} to ${describeMessage(request)}`
    : `${UserName()} removed the ${request.emoji} reaction from ${describeMessage(request)}`;
}

export async function reactToMessage(request: ReactionRequest): Promise<ReactionOutcome> {
  const manager = getHarnessSessionManager();
  if (!manager) throw new Error('No harness session manager');
  const recipient = request.sender ?? request.threadId;

  const current = foldReactions(
    getEvents(request.threadId, { types: [REACTION_ADDED_EVENT, REACTION_REMOVED_EVENT] }),
  ).get(request.messageId) ?? [];
  const existing = current.find((reaction) => reaction.emoji === request.emoji);

  if (request.action === 'add') {
    if (existing) return { status: 'unchanged' };
    const inboxId = enqueueInboxItem({ sessionId: recipient, source: 'reaction', text: reactionLine(request) });
    appendCustomHarnessEvent(manager, request.threadId, REACTION_ADDED_EVENT, {
      messageId: request.messageId,
      emoji: request.emoji,
      recipient,
      inboxId,
    } satisfies ReactionAddedData);
    await handOverNow(recipient, inboxId);
    return { status: 'added', recipient };
  }

  if (!existing) return { status: 'unchanged' };
  if (withdrawInboxItem(existing.inboxId)) {
    appendCustomHarnessEvent(manager, request.threadId, REACTION_REMOVED_EVENT, {
      messageId: request.messageId,
      emoji: request.emoji,
      recipient,
      withdrawn: true,
    } satisfies ReactionRemovedData);
    return { status: 'removed', recipient, withdrawn: true };
  }
  const inboxId = enqueueInboxItem({ sessionId: recipient, source: 'reaction', text: reactionLine(request) });
  appendCustomHarnessEvent(manager, request.threadId, REACTION_REMOVED_EVENT, {
    messageId: request.messageId,
    emoji: request.emoji,
    recipient,
    inboxId,
    withdrawn: false,
  } satisfies ReactionRemovedData);
  await handOverNow(recipient, inboxId);
  return { status: 'removed', recipient, withdrawn: false };
}

// ---------------------------------------------------------------------------
// An agent's own reactions (`lattice session react`)

/**
 * The user's messages in a thread, with the ids the page gives them (`h-<seq>`
 * of the event that shows each one) and whether the agent has read it yet.
 * Same reading of the log as the client's thread (`foldInbox`): a
 * message they typed is its own `input:sent`, or its `input:queued` when it
 * went through the inbox, whose carrying batch is then hidden.
 */
export function usersMessages(events: readonly SessionEvent[]): Array<{ messageId: string; text: string; readAt: number | null }> {
  const inbox = foldInbox(events);
  const readBy = new Map(inbox.items.map((item) => [item.event.seq, item.readBySeq]));
  const messages: Array<{ messageId: string; text: string; readAt: number | null }> = [];
  for (const event of events) {
    if (event.type === 'input:sent') {
      if (inbox.hiddenInputSeqs.has(event.seq)) continue;
      const data = event.data as { text?: string; source?: string };
      if (data.source === 'command' || typeof data.text !== 'string') continue;
      const text = stripPreamble(stripContextRestore(data.text));
      if (!text || isWorkerInput(text)) continue;
      messages.push({ messageId: `h-${event.seq}`, text, readAt: event.seq });
    } else if ((event.type as string) === INBOX_QUEUED_EVENT) {
      const data = event.data as Partial<InboxQueuedData>;
      if (data.source !== 'user' || !data.id || typeof data.text !== 'string') continue;
      messages.push({ messageId: `h-${event.seq}`, text: data.text, readAt: readBy.get(event.seq) ?? null });
    }
  }
  return messages;
}

export interface AgentReactionRequest {
  /** The agent's own conversation: the thread the message is in. */
  threadId: string;
  emoji: string;
  action: 'add' | 'remove';
  /** A specific message (`h-<seq>`); without it, the latest one of the user's the agent has read. */
  messageId?: string;
}

export type AgentReactionOutcome =
  | { status: 'added' | 'removed' | 'unchanged'; messageId: string; text: string }
  | { status: 'no-message'; reason: string };

export function agentReact(request: AgentReactionRequest): AgentReactionOutcome {
  const manager = getHarnessSessionManager();
  if (!manager) throw new Error('No harness session manager');
  // Only what the inbox fold and the reaction fold read, not the whole log.
  const events = getEvents(request.threadId, {
    types: ['input:sent', 'input:resent', INBOX_QUEUED_EVENT, INBOX_READ_EVENT, INPUT_DELIVERED_EVENT, INBOX_WITHDRAWN_EVENT, AGENT_REACTION_EVENT],
  }) as unknown as SessionEvent[];
  const messages = usersMessages(events);

  let target: { messageId: string; text: string } | undefined;
  if (request.messageId) {
    target = messages.find((message) => message.messageId === request.messageId);
    if (!target) return { status: 'no-message', reason: `${request.messageId} is not one of ${userName()}'s messages in ${request.threadId}` };
  } else {
    // The one being answered: the last they sent that a turn has taken in,
    // not one still waiting that the agent has not seen.
    target = messages
      .filter((message) => message.readAt !== null)
      .sort((a, b) => (a.readAt as number) - (b.readAt as number))
      .at(-1);
    if (!target) return { status: 'no-message', reason: `${request.threadId} has no message from ${userName()} that it has read` };
  }

  const current = foldAgentReactions(events).get(target.messageId) ?? [];
  const on = request.action === 'add';
  if (current.includes(request.emoji) === on) return { status: 'unchanged', messageId: target.messageId, text: target.text };
  appendCustomHarnessEvent(manager, request.threadId, AGENT_REACTION_EVENT, {
    messageId: target.messageId,
    emoji: request.emoji,
    on,
  } satisfies AgentReactionData);
  return { status: on ? 'added' : 'removed', messageId: target.messageId, text: target.text };
}
