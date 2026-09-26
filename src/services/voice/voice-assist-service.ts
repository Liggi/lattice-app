/**
 * The voice fast lane.
 *
 * The GPT Live alpha cannot be given tools — `tools` is rejected as an unknown
 * parameter at every level — and delegation content is verbatim ASR of the user's
 * speech rather than text the model authors. So the Live model can never call
 * anything. Its only outward channel is a delegation carrying their own words.
 *
 * This service does two jobs.
 *
 * `buildVoiceContext` assembles everything the voice model should already know
 * — the fleet, each session's own recent words, and what needs the user today —
 * for loading into the session instructions at connect. Instructions hold
 * 16,384 tokens and are recalled well; ambient pushes are capped at 500 tokens
 * and lodge isolated facts rather than a picture. So reads never leave the
 * model holding the conversation, and cost nothing.
 *
 * `runVoiceAct` handles the one thing that cannot be answered from context:
 * turning "tell it to stop" into a message aimed at a specific session. It gets
 * the recent transcript, because that sentence is meaningless without it.
 *
 * Reads run in-process. Anything that mutates a session is returned as an
 * intent for the page to carry out on its already-verified path, so voice never
 * grows a second way to start or resume work.
 */

import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { createLogger } from '@/services/infrastructure/logger.js';
import { ConfigService } from '@/services/infrastructure/config-service.js';
import { getCostTracker } from '@/services/infrastructure/cost-tracker.js';
import { ConversationService } from '@/services/sessions/conversation-service.js';
import { InsightsEngine } from '@/services/insights/insights-engine.js';
import { getHarnessSessionManager } from '@/harness/setup.js';
import { parseJson } from '@/utils/json.js';
import type { SessionInfoService } from '@/services/sessions/session-info-service.js';
import { allowGeneration } from '@/services/infrastructure/generation-gates.js';
import { userName, UserName } from '../user-profile.js';
import { CONFIG_FILE } from '@/utils/constants.js';

const logger = createLogger('VoiceAssist');

/**
 * The act model.
 *
 * `gpt-5.6-luna`, through `/v1/responses` — it rejects function tools on
 * `/v1/chat/completions`. Measured at ~2s for this job at every reasoning
 * effort, and it resolves "tell it to stop" to the right session from the
 * conversation rather than from roster order, which is the whole reason a model
 * is here at all.
 */
const ACT_MODEL = 'gpt-5.6-luna';
const ACT_API_URL = 'https://api.openai.com/v1/responses';

/** Env wins so the service can run with a key that is never written to disk. */
function resolveOpenAiKey(): string | undefined {
  const fromEnv = process.env.OPENAI_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const config = ConfigService.getInstance().getConfig() as { openai?: { apiKey?: string } };
  const fromConfig = config.openai?.apiKey;
  return fromConfig && fromConfig.trim() ? fromConfig.trim() : undefined;
}

/**
 * How much of each session's own words to carry.
 *
 * Ten turns is ~500 tokens per session, measured. The instruction budget is
 * 16,384 tokens and the whole fleet came to about 8,800 when it also carried
 * the (now removed) orientation brief, so this is deliberately generous
 * rather than tuned to the edge.
 */
const DETAIL_TURNS = 10;
const DETAIL_SESSION_LIMIT = 10;

/**
 * Hard ceiling on one ambient push, measured: the API rejects anything over
 * 500 tokens with "Context append text must not exceed 500 tokens". Chars are
 * used as the guard because it is the unit the caller has.
 */
export const CONTEXT_APPEND_MAX_CHARS = 1600;

/** Spoken answers are short by construction; this is a backstop, not a target. */
const MAX_SPOKEN_CHARS = 700;

export type VoiceAssistOutcome =
  | { kind: 'answer'; spoken: string }
  | { kind: 'send'; conversationId: string; message: string; spoken: string }
  | { kind: 'start'; task: string; spoken: string }
  | { kind: 'delegate'; task: string; spoken: string };

export interface VoiceAssistResult {
  outcome: VoiceAssistOutcome;
  toolsUsed: string[];
  elapsedMs: number;
}

/**
 * Live status, supplied by the caller.
 *
 * `GET /api/sessions/status` is the documented single source of truth and the
 * page already polls it, so it is passed in rather than derived a second time
 * here. `ongoing`/`stopping`/`pending` mean running; `idle` means the CLI is up
 * and waiting on the user; `completed` means the process is gone.
 */
export type LiveStatus = Record<string, { status?: string; lastActivityAt?: string | null }>;

export interface VoiceAssistDeps {
  sessionInfoService: SessionInfoService;
  statuses: LiveStatus;
}

function isRunning(status: string | undefined): boolean {
  return status === 'ongoing' || status === 'stopping' || status === 'pending';
}

/**
 * What the act model is told.
 *
 * It is given the same fleet picture the voice model holds plus the recent
 * spoken transcript, because the request it receives is raw speech: "tell it to
 * stop and summarise" only means something relative to what was just said. The
 * previous version of this service passed the utterance alone, and it replied
 * "I don't have the context for what was just said to you" — correctly, since
 * it had never seen the conversation.
 */
function buildActPrompt(context: string, transcript: string): string {
  return [
    `You are the voice ${userName()} is talking to about their Claude Code sessions. They are`,
    'speaking out loud and everything you produce is read back to them aloud:',
    'short, plain, no markdown, no ids, no paths.',
    '',
    'Resolve pronouns from the conversation below. "It", "that one" and "the',
    'census one" refer to whatever was just being discussed — not to the first',
    'session in the list. If you genuinely cannot tell which session they mean,',
    'ask them, briefly.',
    '',
    'MOST OF WHAT HE SAYS IS A QUESTION FOR YOU, not an instruction for a',
    'session. "Give me more on that", "what does that mean", "where has it got',
    'to", "why" — all of those are them talking to you, and you answer them',
    'yourself from what is below. Answer is the default and by far the most',
    'common choice.',
    '',
    'Only route something to a session when they are plainly directing words AT it',
    '— "tell it to…", "ask it to…", "send…", "get it to stop". If they did not say',
    'something like that, they are talking to you.',
    '',
    'Choose exactly one:',
    '- answer: anything you can settle from what is below. Almost always this.',
    '- send_to_session: they explicitly told you to say something to a session.',
    '- start_session: they asked for new work that is small and clearly specified.',
    '- hand_off: this needs real engineering — open-ended investigation, code',
    '  changes, tests. A full session will pick it up.',
    '',
    context,
    '',
    'RECENT CONVERSATION (most recent last):',
    transcript || '(nothing said yet)',
  ].join('\n');
}

interface ActTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

function actTools(): ActTool[] {
  return [
    {
      type: 'function',
      name: 'answer',
      description: `Say this to ${userName()} now. One or two spoken sentences.`,
      parameters: {
        type: 'object',
        properties: { spoken: { type: 'string' } },
        required: ['spoken'],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: 'function',
      name: 'send_to_session',
      description: `Send a message into one of ${userName()}’s sessions.`,
      parameters: {
        type: 'object',
        properties: {
          conversationId: { type: 'string', description: 'The conv- id of the target.' },
          message: { type: 'string', description: 'What to say to that session, plain imperative English.' },
          spoken: { type: 'string', description: `One short sentence telling ${userName()} what you did.` },
        },
        required: ['conversationId', 'message', 'spoken'],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: 'function',
      name: 'start_session',
      description: 'Start a new session on a small, clearly specified task.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          spoken: { type: 'string', description: `One short sentence telling ${userName()} what you did.` },
        },
        required: ['task', 'spoken'],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: 'function',
      name: 'hand_off',
      description: 'Real engineering work that cannot be settled by answering.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The work, restated clearly.' },
          spoken: { type: 'string', description: `One short sentence for ${userName()}.` },
        },
        required: ['task', 'spoken'],
        additionalProperties: false,
      },
      strict: true,
    },
  ];
}

function describeAge(iso: string | null, now: number): string {
  if (!iso) return 'unknown';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export interface FleetRow {
  conversationId: string;
  label: string;
  theme: string | null;
  status: string;
  running: boolean;
  lastActivityAt: string;
  workingDirectory: string;
  /** Argus's prose read of what this session is actually doing, if it has one. */
  context: string | null;
  arrow: string | null;
  arrowKind: string | null;
  snag: string | null;
}

interface AmbientRead {
  sessionId: string;
  context?: string | null;
  arrow?: { kind?: string; text?: string } | null;
  snag?: string | null;
  suggestedNext?: string | null;
  flag?: string | null;
  flagLine?: string | null;
  portfolio?: string | null;
}

/**
 * Argus's latest pass over the fleet.
 *
 * A separate launchd watcher writes this file; it is the only thing in Lattice
 * that describes a session in a sentence rather than a label, which is exactly
 * what a spoken answer needs. Missing or stale is fine — every field is
 * optional to the caller.
 */
async function readAmbient(): Promise<{ generatedAt: string | null; reads: Map<string, AmbientRead> }> {
  const file = join(homedir(), '.lattice', 'ambient', 'latest.json');
  try {
    const parsed = parseJson(await readFile(file, 'utf8')) as {
      generatedAt?: string;
      reads?: AmbientRead[];
    };
    const reads = new Map<string, AmbientRead>();
    for (const read of parsed.reads ?? []) {
      if (read?.sessionId) reads.set(read.sessionId, read);
    }
    return { generatedAt: parsed.generatedAt ?? null, reads };
  } catch {
    return { generatedAt: null, reads: new Map() };
  }
}

/**
 * The fleet as the model should see it.
 *
 * Labels come from the cached insight mission — a written one-line description
 * of what the session is for — falling back to the raw opening prompt only when
 * no insight exists. The raw prompt is the user thinking out loud and reads
 * terribly, which is why it is the last resort rather than the default.
 */
export async function collectFleet(
  deps: VoiceAssistDeps,
  options: { limit?: number; activeOnly?: boolean } = {},
): Promise<FleetRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const conversationService = ConversationService.getInstance();
  const { conversations } = conversationService.listConversations({
    limit,
    archived: false,
  });

  const ids = conversations.map((conversation) => conversation.conversationId);
  let insights = new Map<string, { context?: { mission?: string }; theme?: string }>();
  try {
    insights = (await InsightsEngine.getInstance().getCachedInsightsForSessions(ids)) as typeof insights;
  } catch (err) {
    logger.debug('Cached insights unavailable for the voice fleet', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const ambient = await readAmbient();

  const rows = conversations.map((conversation) => {
    const id = conversation.conversationId;
    const info = deps.sessionInfoService.getSessionInfoSync(id);
    const insight = insights.get(id);
    const read = ambient.reads.get(id);
    const live = deps.statuses[id];

    const mission = insight?.context?.mission?.trim();
    const custom = info?.custom_name?.trim();
    const prompt = conversation.initialPrompt?.trim().replace(/\s+/g, ' ');
    const status = live?.status ?? 'completed';

    return {
      conversationId: id,
      label: custom || mission || (prompt ? prompt.slice(0, 120) : 'Untitled session'),
      theme: insight?.theme ?? null,
      status,
      running: isRunning(status),
      lastActivityAt: live?.lastActivityAt ?? conversation.updatedAt,
      workingDirectory: conversation.workingDirectory,
      context: read?.context?.trim() || null,
      arrow: read?.arrow?.text?.trim() || null,
      arrowKind: read?.arrow?.kind ?? null,
      snag: read?.snag?.trim() || null,
    };
  });

  return options.activeOnly ? rows.filter((row) => row.running) : rows;
}

/**
 * Three buckets, because the difference matters and the status strings do not
 * say it out loud: `idle` means the session is alive and waiting on the user,
 * which is very different from `completed`, which means it is over.
 */
export function renderFleetForModel(rows: FleetRow[], now: number): string {
  if (rows.length === 0) return 'There are no sessions.';

  const running = rows.filter((row) => row.running);
  const waiting = rows.filter((row) => !row.running && row.status === 'idle');
  const done = rows.filter((row) => !row.running && row.status !== 'idle');

  const describe = (row: FleetRow) => {
    const parts = [row.conversationId, row.label];
    if (row.context) parts.push(row.context);
    if (row.arrow) parts.push(`next: ${row.arrow}`);
    if (row.snag) parts.push(`snag: ${row.snag}`);
    parts.push(`last activity ${describeAge(row.lastActivityAt, now)}`);
    return `- ${parts.join(' | ')}`;
  };

  const lines: string[] = [
    running.length === 0
      ? 'Nothing is actively running.'
      : `${running.length} session${running.length === 1 ? ' is' : 's are'} running now:`,
    ...running.map(describe),
  ];

  if (waiting.length > 0) {
    lines.push('', `${waiting.length} open and waiting on ${userName()}:`, ...waiting.map(describe));
  }
  if (done.length > 0) {
    lines.push('', 'Finished recently:', ...done.slice(0, 12).map(describe));
    if (done.length > 12) lines.push(`…and ${done.length - 12} older finished sessions.`);
  }

  return lines.join('\n');
}

const READ_BLOCK_MAX_CHARS = 400;

/**
 * Recent readable output of one session.
 *
 * `thinking` blocks are dropped deliberately: they are the session's private
 * reasoning, long and not the answer the user asked for.
 */
export function readSessionTranscript(conversationId: string, turns: number): string {
  const manager = getHarnessSessionManager();
  if (!manager) return 'The session runtime is not available right now.';

  const limit = Math.min(Math.max(turns, 1), 20) * 12;
  const log = manager.getLog(conversationId);
  const events = log?.hasStorage
    ? log.readFromStorage(conversationId, { limit })
    : manager.readFromStorage(conversationId, { limit });

  if (!events || events.length === 0) return 'That session has no recorded activity.';

  const rendered: string[] = [];
  for (const event of events) {
    const data = event.data as
      | { blocks?: Array<Record<string, unknown>>; text?: string }
      | undefined;

    if (event.type === 'input:sent' && typeof data?.text === 'string') {
      rendered.push(`${UserName()} said: ${data.text.slice(0, READ_BLOCK_MAX_CHARS)}`);
      continue;
    }
    if (event.type !== 'content') continue;

    for (const block of data?.blocks ?? []) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        rendered.push(`Session said: ${block.text.trim().slice(0, READ_BLOCK_MAX_CHARS)}`);
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        rendered.push(`Session ran ${block.name}.`);
      }
    }
  }

  if (rendered.length === 0) return 'That session has only internal activity so far.';
  return rendered.slice(-turns * 3).join('\n');
}

function clampSpoken(text: unknown, fallback: string): string {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return fallback;
  return value.length > MAX_SPOKEN_CHARS ? `${value.slice(0, MAX_SPOKEN_CHARS - 1)}…` : value;
}

/**
 * Everything the voice model should already know, built once at connect.
 *
 * This is the heart of the design. Session instructions hold 16,384 tokens and
 * are recalled well; ambient pushes are capped at 500 tokens each and lodge
 * isolated facts rather than a picture you can enumerate. So the whole fleet —
 * roster and each session's own recent words — is loaded here, and pushes are
 * reserved for what changes.
 *
 * The payoff is that "what's happening", "that one, more detail", and "where is
 * it now" are all answered by the model that is holding the conversation, with
 * no lookup and no latency.
 */
/**
 * Assembling the context reads every session's event log off disk. That is
 * fine once per call, but it was being redone for every spoken sentence and
 * cost several seconds each time. The fleet does not change
 * meaningfully inside a few seconds, and live status is passed in separately,
 * so a short TTL is safe.
 */
let contextCache: { at: number; value: string } | null = null;
const CONTEXT_CACHE_MS = 20_000;

export function invalidateVoiceContext(): void {
  contextCache = null;
}

export async function buildVoiceContext(
  deps: VoiceAssistDeps,
  options: { cached?: boolean } = {},
): Promise<string> {
  if (options.cached && contextCache && Date.now() - contextCache.at < CONTEXT_CACHE_MS) {
    return contextCache.value;
  }
  const value = await assembleVoiceContext(deps);
  contextCache = { at: Date.now(), value };
  return value;
}

async function assembleVoiceContext(deps: VoiceAssistDeps): Promise<string> {
  const rows = await collectFleet(deps, { limit: 25 });
  const now = Date.now();

  const blocks: string[] = ['SESSIONS — this is your knowledge of the fleet.', '', renderFleetForModel(rows, now)];

  // Each session's own words. Running sessions first: they are what the user asks
  // about, and the budget is spent where the conversation goes.
  const detailOrder = [...rows].sort((a, b) => Number(b.running) - Number(a.running));
  const details: string[] = [];
  for (const row of detailOrder.slice(0, DETAIL_SESSION_LIMIT)) {
    const transcript = readSessionTranscript(row.conversationId, DETAIL_TURNS);
    if (!transcript || transcript.startsWith('That session has no')) continue;
    details.push(
      [
        `--- ${row.conversationId} — ${row.label}${row.running ? ' (RUNNING)' : ''}`,
        row.context ? `What it is doing: ${row.context}` : '',
        transcript,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  if (details.length > 0) {
    blocks.push(
      '',
      'WHAT EACH SESSION HAS ACTUALLY SAID — its own recent words, so you can',
      'answer "tell me more about that one" and "where is it now" directly.',
      '',
      details.join('\n\n'),
    );
  }

  return blocks.join('\n');
}

interface ActResponseItem {
  type?: string;
  name?: string;
  arguments?: string;
}

/**
 * Turn one spoken utterance into an action.
 *
 * Single round trip by design: everything it could need to read is already in
 * the prompt, so there is no tool-then-answer loop to pay for. Failure resolves
 * to a hand-off rather than throwing, because on a voice channel falling back
 * to a real session is recoverable and silence is not.
 */
export async function runVoiceAct(
  utterance: string,
  transcript: string,
  deps: VoiceAssistDeps,
): Promise<VoiceAssistResult> {
  // Feature switch. Voice is the one spend path the cost tracker never sees —
  // it bills OpenAI, and only Anthropic usage is recorded — so it stays gated
  // with the rest until there is a spend display covering all three providers.
  if (!allowGeneration('voice')) {
    throw new Error(`Voice mode is off — set generation.voice to true in ${CONFIG_FILE}`);
  }

  const startedAt = Date.now();
  const apiKey = resolveOpenAiKey();
  if (!apiKey) throw new Error('No OpenAI API key is configured for the voice act model.');

  // Cached: the fleet does not shift inside a sentence, and the user is waiting.
  const context = await buildVoiceContext(deps, { cached: true });

  const response = await fetch(ACT_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ACT_MODEL,
      tools: actTools(),
      tool_choice: 'required',
      input: [
        { role: 'system', content: buildActPrompt(context, transcript) },
        { role: 'user', content: utterance },
      ],
    }),
  });

  const body = (await response.json()) as {
    output?: ActResponseItem[];
    error?: { message?: string };
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  if (!response.ok) {
    throw new Error(body.error?.message ?? `Act model returned HTTP ${response.status}`);
  }

  const call = (body.output ?? []).find((item) => item.type === 'function_call');
  const elapsedMs = Date.now() - startedAt;

  // Record the spend. Until 2026-08-28 this call billed OpenAI and wrote
  // nothing anywhere, so voice was invisible to every cost figure Lattice
  // produced. A failure to log must not fail the utterance — the user is waiting.
  try {
    getCostTracker().log({
      sessionId: 'voice',
      operation: 'VOICE_ACT',
      model: ACT_MODEL,
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
      durationMs: elapsedMs,
      source: 'voice',
      provider: 'openai',
    });
  } catch {
    // Ledger write failed; the utterance still completes.
  }

  if (!call?.name) {
    return {
      outcome: { kind: 'delegate', task: utterance, spoken: 'Let me put a session on that.' },
      toolsUsed: [],
      elapsedMs,
    };
  }

  let input: Record<string, unknown> = {};
  try {
    input = parseJson(call.arguments ?? '{}') as Record<string, unknown>;
  } catch {
    input = {};
  }

  const finish = (outcome: VoiceAssistOutcome): VoiceAssistResult => ({
    outcome,
    toolsUsed: [call.name!],
    elapsedMs,
  });

  switch (call.name) {
    case 'send_to_session':
      return finish({
        kind: 'send',
        conversationId: String(input.conversationId ?? ''),
        message: String(input.message ?? ''),
        spoken: clampSpoken(input.spoken, 'Sent it.'),
      });
    case 'start_session':
      return finish({
        kind: 'start',
        task: String(input.task ?? utterance),
        spoken: clampSpoken(input.spoken, 'Starting a session on it.'),
      });
    case 'hand_off':
      return finish({
        kind: 'delegate',
        task: String(input.task ?? utterance),
        spoken: clampSpoken(input.spoken, 'Let me get a session on that.'),
      });
    default:
      return finish({
        kind: 'answer',
        spoken: clampSpoken(input.spoken, 'I did not catch that.'),
      });
  }
}
