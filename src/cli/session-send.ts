/**
 * `lattice session send` — post a message into an existing conversation
 * through the same `/api/harness/:id/send` endpoint the composer uses. The
 * server resumes a conversation whose process has exited, so this works on
 * an idle worker as well as a running one. The receipt confirms acceptance,
 * not completion.
 */

import { parseJson } from '../utils/json.js';
import { serverAuthHeaders } from './server-auth.js';

export async function sendSessionMessage(options: {
  host: string;
  port: number;
  conversationId: string;
  message: string;
  model?: string;
  from?: string;
  summary?: string;
  /** A different assignment for a worker being reused; what its card is called from now on. */
  task?: string;
  /** With `task`: the open thread the new assignment is. */
  thread?: number;
  passedOn?: boolean;
  /** Seq of the worker's question this message answers; what clears it from the coordinator's pending list. */
  answers?: number;
  interrupt?: boolean;
  /** Hold it for the end of the running turn even where it would otherwise go straight in. */
  afterTurn?: boolean;
}): Promise<Record<string, unknown>> {
  if (!options.message.trim()) throw new Error('send requires a non-empty message');
  // A sent message reaches the provider under a sender header, so a slash
  // command in it arrives as text and the provider never runs it.
  if (options.message.trim() === '/compact') {
    throw new Error(`a sent /compact reaches the agent as text, not a command; use \`session compact ${options.conversationId}\``);
  }
  const response = await fetch(
    `http://${options.host}:${options.port}/api/harness/${encodeURIComponent(options.conversationId)}/send`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...serverAuthHeaders() },
      body: JSON.stringify({
        input: options.message,
        // The route labels the message for its reader by what the sender
        // declared. With no --from the sender is unknown, and saying so
        // (rather than letting it read as the user's) is the point of the flag.
        origin: 'cli',
        ...(options.model ? { model: options.model } : {}),
        ...(options.from ? { from: options.from } : {}),
        ...(options.summary ? { summary: options.summary } : {}),
        ...(options.task ? { task: options.task } : {}),
        ...(options.thread !== undefined ? { thread: options.thread } : {}),
        ...(options.passedOn ? { passedOn: true } : {}),
        ...(options.answers !== undefined ? { answers: options.answers } : {}),
        ...(options.interrupt ? { interrupt: true } : {}),
        ...(options.afterTurn ? { afterTurn: true } : {}),
      }),
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`server rejected send (HTTP ${response.status}): ${text}`);
  const result = parseJson(text);
  if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) {
    throw new Error(`server returned an unexpected send receipt: ${text}`);
  }
  return { ...(result as Record<string, unknown>), conversationId: options.conversationId };
}

/**
 * `lattice session compact` — compact a conversation's context through the
 * `/api/harness/:id/compact` endpoint the composer's `/compact` uses. The
 * server refuses (409) while the session is in a turn rather than stopping it.
 */
export async function compactSession(options: { host: string; port: number; conversationId: string }): Promise<Record<string, unknown>> {
  const response = await fetch(
    `http://${options.host}:${options.port}/api/harness/${encodeURIComponent(options.conversationId)}/compact`,
    { method: 'POST', headers: { 'content-type': 'application/json', ...serverAuthHeaders() }, body: '{}' },
  );
  const text = await response.text();
  if (response.status === 409) {
    const reason = (parseJson(text) as { error?: string } | null)?.error ?? text;
    throw new Error(`${options.conversationId} was not compacted: ${reason}. Nothing was stopped; run this again once its turn has ended.`);
  }
  if (!response.ok) throw new Error(`server rejected compact (HTTP ${response.status}): ${text}`);
  return { ...(parseJson(text) as Record<string, unknown>), conversationId: options.conversationId };
}

/**
 * `lattice session react` — an agent's own emoji on one of the user's messages
 * in its conversation, through `/api/harness/:id/agent-reactions`. The
 * server picks their latest read message unless a message id is given.
 */
export async function reactToUsersMessage(options: {
  host: string;
  port: number;
  conversationId: string;
  emoji: string;
  remove?: boolean;
  messageId?: string;
}): Promise<Record<string, unknown>> {
  const response = await fetch(
    `http://${options.host}:${options.port}/api/harness/${encodeURIComponent(options.conversationId)}/agent-reactions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...serverAuthHeaders() },
      body: JSON.stringify({
        emoji: options.emoji,
        action: options.remove ? 'remove' : 'add',
        ...(options.messageId ? { messageId: options.messageId } : {}),
      }),
    },
  );
  const text = await response.text();
  const result = parseJson(text) as Record<string, unknown> | null;
  if (!response.ok) {
    const reason = typeof result?.error === 'string' ? result.error : typeof result?.reason === 'string' ? result.reason : text;
    throw new Error(`no reaction made: ${reason}`);
  }
  return { ...(result ?? {}), conversationId: options.conversationId };
}
