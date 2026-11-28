/**
 * The server's own state, wired as the Inbox feed's sources
 * (`inbox-feed.ts`). Every read is local: SQLite, the job store and the
 * shipping watcher's last snapshot.
 */

import { ConversationService } from './conversation-service.js';
import { SessionInfoService } from './session-info-service.js';
import { openDecision } from './open-decision.js';
import { readProjectState } from './project-state.js';
import { foldedWorkerStates } from './worker-events.js';
import { repliesOf } from './held-replies.js';
import { jobWatch } from './job-watch.js';
import { shippingWatch } from './shipping-watch.js';
import { inboxDismissals } from './inbox-dismissals.js';
import { getEvents } from '../../session-history/repository.js';
import { getEventStorage } from '../../harness/event-message-reader.js';
import { deriveSessionStatusFromEvents, type RunFailure } from '../../harness/derive-session-status.js';
import { endsAskingTurn } from '../../types/decisions.js';
import { InsightsEngine } from '../insights/insights-engine.js';
import type { InboxConversation, InboxSources } from './inbox-feed.js';

const MAX_CONVERSATIONS = 500;
const MAX_EXCERPT_CHARS = 320;
const MAX_CONTEXT_CACHE = 500;

/** A session's failure, re-derived only when its log has grown. */
const failures = new Map<string, { seq: number; failure: RunFailure | null }>();
/** Cached fallback context excerpts per `${conversationId}:${decisionSeq}` (events at a seq are immutable). */
const decisionContexts = new Map<string, string | null>();

function failureOf(conversationId: string): RunFailure | null {
  const storage = getEventStorage();
  const seq = storage.maxSeq(conversationId);
  if (seq === 0) return null;
  const cached = failures.get(conversationId);
  if (cached?.seq === seq) return cached.failure;
  const { failure } = deriveSessionStatusFromEvents(storage.readStatusWindow(conversationId, 200));
  failures.set(conversationId, { seq, failure });
  return failure;
}

/** Pulls plain text from a harness `content` event, skipping thinking/tool blocks. Exported for tests. */
export function assistantTextFromEvent(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const record = data as { role?: unknown; text?: unknown; content?: unknown; blocks?: unknown; block?: unknown };
  if (record.role && record.role !== 'assistant') return '';
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;
  const blocks = Array.isArray(record.blocks)
    ? record.blocks
    : Array.isArray(record.content)
      ? record.content
      : record.block && typeof record.block === 'object'
        ? [record.block]
        : [];
  const parts: string[] = [];
  for (const block of blocks) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('\n');
}

function summarizeAssistantTurn(raw: string): string | null {
  const cleaned = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (cleaned.length === 0) return null;
  let out = cleaned[0];
  if (out.length < 160 && cleaned.length > 1) {
    out = `${out}\n\n${cleaned[1]}`;
  }
  if (out.length <= MAX_EXCERPT_CHARS) return out;
  return `${out.slice(0, MAX_EXCERPT_CHARS - 1).trimEnd()}…`;
}

/**
 * Fallback cold-read context for legacy `lattice ask` cards that carry neither
 * `context` bullets nor `detail`: extracts the assistant message written in the
 * same asking turn from local SQLite events.
 */
function decisionContextOf(conversationId: string, decisionSeq: number): string | null {
  const key = `${conversationId}:${decisionSeq}`;
  if (decisionContexts.has(key)) return decisionContexts.get(key) ?? null;
  const after = getEvents(conversationId, { fromSeq: decisionSeq + 1, toSeq: decisionSeq + 40 });
  const afterChunks: string[] = [];
  for (const event of after) {
    if (event.type === 'content') {
      const text = assistantTextFromEvent(event.data);
      if (text) afterChunks.push(text);
    }
    if (endsAskingTurn(event)) break;
  }
  let excerpt = summarizeAssistantTurn(afterChunks.join(''));
  if (!excerpt && decisionSeq > 1) {
    const before = getEvents(conversationId, { fromSeq: Math.max(1, decisionSeq - 30), toSeq: decisionSeq - 1 });
    const beforeChunks: string[] = [];
    for (let i = before.length - 1; i >= 0; i -= 1) {
      const event = before[i];
      if (event.type === 'user:sent' || endsAskingTurn(event)) break;
      if (event.type === 'content') {
        const text = assistantTextFromEvent(event.data);
        if (text) beforeChunks.unshift(text);
      }
    }
    excerpt = summarizeAssistantTurn(beforeChunks.join(''));
  }
  if (decisionContexts.size >= MAX_CONTEXT_CACHE) {
    const oldest = decisionContexts.keys().next().value;
    if (oldest !== undefined) decisionContexts.delete(oldest);
  }
  decisionContexts.set(key, excerpt);
  return excerpt;
}

/** Named as the sidebar names them (`conversationTitle`): the user's name, the project's, the mission, the purpose, the prompt. */
async function openConversations(): Promise<InboxConversation[]> {
  const { conversations } = ConversationService.getInstance().listConversations({ archived: false, limit: MAX_CONVERSATIONS });
  const ids = conversations.map((conversation) => conversation.conversationId);
  const info = SessionInfoService.getInstance().getSessionInfoBatch(ids, { includeIdentityImage: false });
  const insights = await InsightsEngine.getInstance().getCachedInsightsForSessions(ids);
  return conversations.map((conversation) => {
    const row = info.get(conversation.conversationId);
    const read = insights.get(conversation.conversationId);
    const prompt = conversation.initialPrompt?.split('\n').map((line) => line.trim()).find(Boolean);
    return {
      conversationId: conversation.conversationId,
      title: row?.custom_name?.trim() || row?.project_name?.trim() || read?.context?.mission?.trim() || read?.purpose?.trim() || prompt || conversation.conversationId,
      pickedUpFrom: conversation.pickedUpFrom ?? null,
      coordinator: conversation.coordinator,
    };
  });
}

export async function readInboxSources(now = Date.now()): Promise<InboxSources> {
  const dismissals = inboxDismissals();
  return {
    now,
    conversations: await openConversations(),
    openDecision,
    project: readProjectState,
    workers: foldedWorkerStates,
    repliedAt: repliesOf,
    failure: failureOf,
    runningJobs: () => jobWatch().store.running(now),
    shipping: (conversationId) => shippingWatch().peek(conversationId),
    decisionContext: decisionContextOf,
    isDismissed: (id, signature) => dismissals.isDismissed(id, signature),
  };
}
