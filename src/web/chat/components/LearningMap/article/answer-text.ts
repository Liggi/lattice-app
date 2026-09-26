/**
 * Pulling one answer out of a responder session's transcript.
 *
 * The responder is a normal conversation that may already have history, may be
 * mid-turn when the question arrives, and will keep going after it. So the
 * answer is not "the last assistant message" — it is the assistant text that
 * follows *our* question in the transcript.
 *
 * The question is found by its own text: the harness echoes the sent input back
 * as a user message, so the ask message we composed is the marker. Until that
 * marker shows up, `found` is false and the caller keeps waiting — which is
 * also what makes a queued question (sent while the session was mid-turn) wait
 * for the right turn instead of capturing the tail of the previous one.
 */

import type { ChatMessage, DisplayContentBlock } from '../../../types';

/** Visible text of a message body, ignoring tool calls and thinking blocks. */
export function messageText(content: string | DisplayContentBlock[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text')
    .map((block) => (typeof (block as { text?: unknown }).text === 'string'
      ? (block as { text: string }).text
      : ''))
    .join('');
}

export interface AnswerExtraction {
  /** True once the asked question is present in the transcript. */
  found: boolean;
  /** Assistant text after the question, concatenated. Trimmed; may be empty. */
  text: string;
}

export function extractAnswerAfter(
  messages: readonly ChatMessage[],
  askMessage: string,
): AnswerExtraction {
  if (askMessage.trim() === '') return { found: false, text: '' };

  // Last occurrence: the same question asked twice should read the newer turn.
  let askIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.type !== 'user') continue;
    if (messageText(message.content).includes(askMessage)) {
      askIndex = i;
      break;
    }
  }
  if (askIndex < 0) return { found: false, text: '' };

  const parts: string[] = [];
  for (let i = askIndex + 1; i < messages.length; i += 1) {
    const message = messages[i];
    // Subagent output is nested under its parent tool use and is not the
    // session's own answer to us.
    if (message.type !== 'assistant' || message.parentToolUseId) continue;
    const text = messageText(message.content).trim();
    if (text !== '') parts.push(text);
  }

  return { found: true, text: parts.join('\n\n').trim() };
}
