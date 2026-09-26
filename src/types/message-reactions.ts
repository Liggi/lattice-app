/**
 * The user's emoji reactions on messages, as events in the log of the thread
 * they reacted in. Shared by the server (`services/sessions/message-reactions.ts`)
 * and the page, which folds them into what shows under each message.
 *
 *   `reaction:added   { messageId, emoji, recipient, inboxId }`
 *   `reaction:removed { messageId, emoji, recipient, inboxId?, withdrawn }`
 *
 * `messageId` is the thread's own id for the message (`h-…`, as the page
 * renders it). `recipient` is the session the reaction was delivered to:
 * the thread's own agent, or the agent that sent the message into it.
 * `inboxId` is the recipient's inbox row that carried it. On a removal,
 * `withdrawn` says the added row was taken back before any turn read it, so
 * the agent was never told either way; otherwise `inboxId` is the row that
 * tells it the reaction was removed.
 */
export const REACTION_ADDED_EVENT = 'reaction:added';
export const REACTION_REMOVED_EVENT = 'reaction:removed';

export interface ReactionAddedData {
  messageId: string;
  emoji: string;
  recipient: string;
  inboxId: string;
}

export interface ReactionRemovedData {
  messageId: string;
  emoji: string;
  recipient: string;
  inboxId?: string;
  withdrawn: boolean;
}

interface ReactionEventLike {
  type: string;
  data: unknown;
}

/** The reactions on each message, in the order they were added. */
export function foldReactions(events: readonly ReactionEventLike[]): Map<string, Array<{ emoji: string; inboxId: string }>> {
  const byMessage = new Map<string, Array<{ emoji: string; inboxId: string }>>();
  for (const event of events) {
    if (event.type === REACTION_ADDED_EVENT) {
      const data = event.data as Partial<ReactionAddedData>;
      if (!data.messageId || !data.emoji || !data.inboxId) continue;
      const current = byMessage.get(data.messageId) ?? [];
      if (!current.some((reaction) => reaction.emoji === data.emoji)) {
        byMessage.set(data.messageId, [...current, { emoji: data.emoji, inboxId: data.inboxId }]);
      }
    } else if (event.type === REACTION_REMOVED_EVENT) {
      const data = event.data as Partial<ReactionRemovedData>;
      if (!data.messageId || !data.emoji) continue;
      const current = byMessage.get(data.messageId);
      if (!current) continue;
      const next = current.filter((reaction) => reaction.emoji !== data.emoji);
      if (next.length > 0) byMessage.set(data.messageId, next);
      else byMessage.delete(data.messageId);
    }
  }
  return byMessage;
}

/**
 * An agent's own reaction on one of the user's messages in its thread, put there
 * with `lattice session react`. It tells the user something ("seen", "on it")
 * without a reply, so nothing is delivered anywhere; the page shows it under
 * their message.
 *
 *   `reaction:agent { messageId, emoji, on }`
 *
 * `on` is false when the agent took it back.
 */
export const AGENT_REACTION_EVENT = 'reaction:agent';

export interface AgentReactionData {
  messageId: string;
  emoji: string;
  on: boolean;
}

/**
 * One emoji, as a reaction must be: a single grapheme that is a pictograph,
 * a flag or a keycap. `:thumbsup:`, `+1` or a word is refused rather than
 * shown as a chip of text.
 */
export function isSingleEmoji(text: string): boolean {
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)];
  if (graphemes.length !== 1) return false;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|^[#*0-9]\uFE0F?\u20E3$/u.test(text);
}

/** The agent's reactions on each of the user's messages, in the order it added them. */
export function foldAgentReactions(events: readonly ReactionEventLike[]): Map<string, string[]> {
  const byMessage = new Map<string, string[]>();
  for (const event of events) {
    if (event.type !== AGENT_REACTION_EVENT) continue;
    const data = event.data as Partial<AgentReactionData>;
    if (!data.messageId || !data.emoji) continue;
    const current = byMessage.get(data.messageId) ?? [];
    const next = data.on
      ? (current.includes(data.emoji) ? current : [...current, data.emoji])
      : current.filter((emoji) => emoji !== data.emoji);
    if (next.length > 0) byMessage.set(data.messageId, next);
    else byMessage.delete(data.messageId);
  }
  return byMessage;
}
