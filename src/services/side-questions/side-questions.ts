/**
 * Side questions: the user highlights a passage of an agent's message and asks
 * about it without moving the conversation on.
 *
 * Each side chat is a Lattice session of its own: a copy of the session's
 * Claude transcript as it stands (mid-turn included) under a new id, recorded
 * as a conversation created hidden, the way a fixture is, so it never reaches
 * the sidebar. It runs through the ordinary pipeline with the session's own
 * model and permission mode, so it can do whatever the session can (tools,
 * permission prompts, Stop, attachments), and the page shows it with the
 * ordinary chat view. Its first message carries the passage in a server note,
 * which the thread does not show. Running on the session's own model, it
 * reuses the session's prompt cache (seen 2026-10-29 with the earlier bare
 * fork: 70,660 of 73,850 tokens read from cache).
 *
 * Nothing reaches the session unless the user presses Add to thread: their
 * questions word for word, each answer shortened by a throwaway fork of the
 * side chat, as an inbox item that rides along with whatever the session reads
 * next (`RIDE_ALONG_SOURCES`), so it never starts a turn.
 *
 * Side chats from before this (side_conversation_id null) were answered by a
 * bare fork process; they keep their exchanges and can be read, not continued.
 *
 * Claude only. Codex has `thread/fork` on its app-server; `createSideChat` is
 * the place a Codex path would go once a Codex session can be tested here.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { DatabaseProvider } from '../infrastructure/database-provider.js';
import { createLogger } from '../infrastructure/logger.js';
import { agentEnv } from '../infrastructure/agent-env.js';
import { findUserClaudeExecutable } from '../process/claude-cli.js';
import { claudeSpawnEnv } from '../../process-daemon/claude-spawn-auth.js';
import { ConversationService } from '../sessions/conversation-service.js';
import { SessionBranchService } from '../sessions/session-branch-service.js';
import { SessionInfoService } from '../sessions/session-info-service.js';
import { enqueueInboxItem } from '../sessions/session-inbox.js';
import { getEvents } from '../../session-history/repository.js';
import { getHarnessSessionManager } from '../../harness/setup.js';
import { SERVER_NOTE_END, SERVER_NOTE_PREFIX, stripContextRestore } from '../../types/worker-events.js';
import { userName, UserName } from '../user-profile.js';
import { parseJson } from '../../utils/json.js';
import { LatticeError } from '../../types/index.js';

const logger = createLogger('SideQuestions');

/** One question and answer of a side chat from before side chats were sessions. */
export interface SideExchange {
  question: string;
  answer: string | null;
  error?: string;
  askedAt: string;
}

export interface SideQuestion {
  id: string;
  conversationId: string;
  messageId: string;
  quote: string;
  quoteStart: number | null;
  /** The hidden session the side chat is; null for one from before side chats were sessions. */
  sideConversationId: string | null;
  /**
   * A side chat from before side chats were sessions: its questions and answers.
   * A side chat session: what has been added to the thread so far, answers shortened.
   */
  exchanges: SideExchange[];
  /** Questions asked in the side chat so far. */
  questionCount: number;
  /** Of those, how many are in the thread; a later follow-up can be added on top. */
  addedCount: number;
  /** When it was last added to the thread. */
  addedAt: string | null;
  createdAt: string;
}

interface Row {
  id: string;
  conversation_id: string;
  message_id: string;
  quote: string;
  quote_start: number | null;
  side_conversation_id: string | null;
  exchanges_json: string;
  added_at: string | null;
  created_at: string;
}

function db(): Database.Database {
  return DatabaseProvider.getInstance().getDb();
}

function toSideQuestion(row: Row): SideQuestion {
  const exchanges = parseJson(row.exchanges_json) as SideExchange[];
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    quote: row.quote,
    quoteStart: row.quote_start,
    sideConversationId: row.side_conversation_id,
    exchanges,
    questionCount: row.side_conversation_id ? sideChatQuestions(row.side_conversation_id).length : exchanges.length,
    addedCount: row.side_conversation_id ? exchanges.length : row.added_at ? exchanges.length : 0,
    addedAt: row.added_at,
    createdAt: row.created_at,
  };
}

function getRow(id: string): Row {
  const row = db().prepare(`SELECT * FROM side_questions WHERE id = ?`).get(id) as Row | undefined;
  if (!row) throw new LatticeError('SIDE_QUESTION_NOT_FOUND', `No side question ${id}`, 404);
  return row;
}

export function listSideQuestions(conversationId: string): SideQuestion[] {
  const rows = db().prepare(
    `SELECT * FROM side_questions WHERE conversation_id = ? ORDER BY created_at ASC`,
  ).all(conversationId) as Row[];
  return rows.map(toSideQuestion);
}

export function getSideQuestion(id: string): SideQuestion {
  return toSideQuestion(getRow(id));
}

/** The session a side chat is copied from: its Claude transcript, folder, workspace and model. */
function forkSource(conversationId: string): { providerSessionId: string; cwd: string; workspace: string; model: string | null } {
  const conversations = ConversationService.getInstance();
  const conversation = conversations.getConversation(conversationId);
  const segment = conversations.getLatestSegment(conversationId);
  if (!conversation || !segment) throw new LatticeError('CONVERSATION_NOT_FOUND', `No conversation ${conversationId}`, 404);
  if (segment.provider !== 'claude') {
    throw new LatticeError('SIDE_QUESTION_UNSUPPORTED', 'Side questions work on Claude sessions only for now.', 400);
  }
  const psid = segment.providerSessionId;
  if (!psid || psid.startsWith('pending-')) {
    throw new LatticeError('SIDE_QUESTION_NOT_READY', 'This session has no Claude transcript yet to ask about.', 409);
  }
  return {
    providerSessionId: psid,
    cwd: conversation.workingDirectory,
    workspace: conversation.workspace,
    model: segment.model && segment.model !== 'unknown' ? segment.model : null,
  };
}

/** The first message of a side chat; the server note in front of the question is not shown in the thread. */
export function firstQuestionPrompt(quote: string, question: string): string {
  return [
    `${SERVER_NOTE_PREFIX} ${userName()} opened a side chat about a passage of your message. This is a copy of the`,
    'session: the main conversation will not see what happens here unless they add it to the thread. Answer what',
    'they ask here; do not carry on with the task you were doing unless they ask you to.',
    '',
    'The passage:',
    quote.split('\n').map((line) => `> ${line}`).join('\n'),
    SERVER_NOTE_END,
    '',
    question,
  ].join('\n');
}

/** What the page sends to start the side chat's first turn (`POST /api/harness/:id/start`). */
export interface SideChatStart {
  prompt: string;
  permissionMode: string | null;
}

/**
 * Open a side chat about a passage: copy the session's transcript, record the
 * copy as a hidden session on the session's model and permission mode, and
 * return the first message for the page to start it with, through the same
 * start route the composer uses.
 */
export async function createSideChat(input: {
  conversationId: string;
  messageId: string;
  quote: string;
  quoteStart: number | null;
  question: string;
}): Promise<{ sideQuestion: SideQuestion; start: SideChatStart }> {
  const source = forkSource(input.conversationId);
  const providerSessionId = await SessionBranchService.getInstance().copyWholeTranscript(source.providerSessionId);
  const conversations = ConversationService.getInstance();
  // Created archived in one transaction, so it is never in the sidebar, even for a moment.
  const { conversationId: sideConversationId } = conversations.createConversation({
    workingDirectory: source.cwd,
    provider: 'claude',
    providerSessionId,
    ...(source.model ? { model: source.model } : {}),
    workspace: source.workspace,
    archived: true,
  });
  const sessionInfo = SessionInfoService.getInstance();
  const permissionMode = sessionInfo.getMergedSessionInfo(input.conversationId, source.providerSessionId)?.permission_mode ?? null;
  await sessionInfo.updateSessionInfo(sideConversationId, {
    custom_name: `Side question: ${input.question}`,
    ...(permissionMode ? { permission_mode: permissionMode } : {}),
  });
  const id = `sq-${randomUUID()}`;
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO side_questions (id, conversation_id, message_id, quote, quote_start, side_conversation_id, model, exchanges_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
  ).run(id, input.conversationId, input.messageId, input.quote, input.quoteStart, sideConversationId, source.model, now, now);
  logger.info('Side chat opened', { id, conversationId: input.conversationId, sideConversationId, permissionMode });
  return {
    sideQuestion: getSideQuestion(id),
    start: { prompt: firstQuestionPrompt(input.quote, input.question), permissionMode },
  };
}

/** The user's questions in a side chat, word for word, in order. */
export function sideChatQuestions(sideConversationId: string): string[] {
  return getEvents(sideConversationId, { types: ['input:sent'] })
    .filter((event) => (event.data as { source?: string } | null)?.source !== 'command')
    .map((event) => stripContextRestore((event.data as { text?: string } | null)?.text ?? '').trim())
    .filter((text) => text.length > 0);
}

function shortenPrompt(questions: string[]): string {
  return [
    `[The user is adding this side chat to the main conversation. These are the questions of theirs to add, in order:`,
    ...questions.map((question, index) => `${index + 1}. ${JSON.stringify(question)}`),
    'For each question, write one plain sentence of at most 30 words that keeps the substance of what you answered',
    'or did about it, for the main conversation to read. Plain text: no markdown, backticks or quotation of code.',
    'Reply with JSON only, no code fence: {"answers": ["...", "..."]}, one string per question. Use no tools.]',
  ].join('\n');
}

/**
 * One turn of a throwaway fork of the side chat, with no tools, for the
 * shortened answers. Its transcript is deleted once it has answered.
 */
function runShortenFork(input: { resume: string; cwd: string; model: string | null; prompt: string }): Promise<string> {
  const claude = findUserClaudeExecutable();
  if (!claude) throw new LatticeError('CLAUDE_NOT_INSTALLED', 'Claude Code is not installed on the machine running Lattice.', 400);
  const args = [
    '-p',
    '--resume', input.resume,
    '--fork-session',
    ...(input.model ? ['--model', input.model] : []),
    '--tools', '',
    '--strict-mcp-config',
    '--settings', JSON.stringify({ disableAllHooks: true }),
    '--output-format', 'stream-json', '--verbose',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(claude, args, {
      cwd: fs.existsSync(input.cwd) ? input.cwd : os.homedir(),
      env: { ...agentEnv(), ...claudeSpawnEnv(input.model ?? undefined) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(input.prompt);
    let forkId: string | null = null;
    let result: { text: string; isError: boolean } | null = null;
    let buffer = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: Record<string, unknown>;
        try {
          message = parseJson(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (typeof message.session_id === 'string') forkId ??= message.session_id;
        if (message.type === 'result') {
          result = { text: typeof message.result === 'string' ? message.result : '', isError: message.is_error === true };
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (forkId) {
        void SessionBranchService.getInstance().removeTranscript(forkId).catch((err: unknown) => {
          logger.warn('Could not delete the shortening fork', { forkId, error: err instanceof Error ? err.message : String(err) });
        });
      }
      if (!result || result.isError) {
        reject(new Error(result?.isError ? result.text : stderr.trim() || `claude exited with code ${code}`));
        return;
      }
      resolve(result.text);
    });
  });
}

/** What the session reads when the side chat is added to the thread. */
export function sideQuestionInboxText(quote: string, exchanges: Array<{ question: string; answer: string }>): string {
  const lines = [
    `[Side question · ${UserName()} asked about a passage of your message in a side chat, answered by a copy of this`
      + ' session. Added here for your context; it needs no reply and is not a new request.]',
    quote.split('\n').map((line) => `> ${line}`).join('\n'),
  ];
  for (const exchange of exchanges) lines.push('', `${UserName()}: ${exchange.question}`, `Answer: ${exchange.answer}`);
  return lines.join('\n');
}

const adding = new Set<string>();

/**
 * Add the side chat to the thread: the user's questions as they wrote them,
 * each answer shortened by a throwaway fork of the side chat, queued for the
 * session to read with its next input. Added again after a follow-up, only
 * what is new goes in.
 */
export async function addSideQuestionToThread(id: string): Promise<SideQuestion> {
  const row = getRow(id);
  const sideId = row.side_conversation_id;
  if (!sideId) {
    if (row.added_at) return toSideQuestion(row);
    throw new LatticeError('SIDE_QUESTION_OLD', 'This side chat is from before side chats could continue; it can only be read.', 409);
  }
  const already = parseJson(row.exchanges_json) as Array<{ question: string; answer: string }>;
  if (adding.has(id)) throw new LatticeError('SIDE_QUESTION_BUSY', 'This side chat is already being added.', 409);
  const status = getHarnessSessionManager()?.inspect(sideId)?.status;
  if (status && status !== 'idle') throw new LatticeError('SIDE_QUESTION_BUSY', 'Wait for the side chat to finish before adding it to the thread.', 409);
  const asked = sideChatQuestions(sideId);
  const questions = asked.slice(already.length);
  if (questions.length === 0) return toSideQuestion(row);
  const conversations = ConversationService.getInstance();
  const segment = conversations.getLatestSegment(sideId);
  if (!segment?.providerSessionId) throw new LatticeError('SIDE_QUESTION_NOT_READY', 'The side chat has no transcript yet.', 409);
  adding.add(id);
  let shortened: string[];
  try {
    const text = await runShortenFork({
      resume: segment.providerSessionId,
      cwd: conversations.getConversation(sideId)?.workingDirectory ?? os.homedir(),
      model: segment.model && segment.model !== 'unknown' ? segment.model : null,
      prompt: shortenPrompt(questions),
    });
    shortened = parseShortAnswers(text, questions.length);
  } finally {
    adding.delete(id);
  }
  const exchanges = questions.map((question, index) => ({ question, answer: shortened[index] }));
  const addedAt = new Date().toISOString();
  // Claimed against what was there when this started, so two adds cannot both go in.
  const claimed = db().prepare(`UPDATE side_questions SET exchanges_json = ?, added_at = ?, updated_at = ? WHERE id = ? AND exchanges_json = ?`)
    .run(JSON.stringify([...already, ...exchanges]), addedAt, addedAt, id, row.exchanges_json);
  if (claimed.changes === 0) return getSideQuestion(id);
  enqueueInboxItem({
    sessionId: row.conversation_id,
    source: 'side-question',
    text: sideQuestionInboxText(row.quote, exchanges),
    deliveryId: `side-question:${id}:${already.length}`,
    sideQuestion: { passage: row.quote, exchanges },
  });
  return getSideQuestion(id);
}

/** The fork's shortened answers, one per question; anything else is an error, not a guess. */
export function parseShortAnswers(text: string, expected: number): string[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`The shortened answers were not JSON: ${text}`);
  const parsed = parseJson(text.slice(start, end + 1)) as { answers?: unknown };
  const answers = parsed.answers;
  if (!Array.isArray(answers) || answers.length !== expected || !answers.every((a) => typeof a === 'string' && a.trim())) {
    throw new Error(`Expected ${expected} shortened answers, got ${JSON.stringify(answers)}`);
  }
  return (answers as string[]).map((a) => a.trim());
}
