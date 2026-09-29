/**
 * CLI subcommand handlers for `lattice session ...`. Reads SQLite directly
 * via the session-history modules; does not require the server to be running
 * (`new` and `send` are the exceptions — they POST to the running server).
 *
 * Argument parsing lives in ./session-cli-spec.ts: every verb declares its
 * flags there, so an unknown flag is an error rather than a silent no-op and
 * `--help` is generated from the same table the parser enforces.
 */

import { userName } from '../services/user-profile.js';
import fs from 'fs';
import path from 'path';
import { DatabaseProvider } from '../services/infrastructure/database-provider.js';
import { CONFIG_DIR } from '../utils/constants.js';
import { compactSession, reactToUsersMessage, sendSessionMessage } from './session-send.js';
import { serverAuthHeaders } from './server-auth.js';
import { latticeCli } from '../services/sessions/pickup-prompts.js';

import {
  renderProjectState,
  RECONCILE_DISPOSITIONS,
  THREAD_WAIT_KINDS,
  type ProjectNotedData,
  type ProjectState,
  type ThreadOwner,
  type ThreadWait,
} from '../types/project-state.js';
import { parseJson } from '../utils/json.js';
import { deriveSessionStatusFromEvents } from '../harness/derive-session-status.js';
import { workerResumedAfterReport, workerRuntimeWord, workerWaitingOn, type ProjectStateResponse, type WorkersResponse } from '../types/worker-events.js';
import type { UnreadInboxSummary } from '../types/inbox.js';
import {
  conversationExists,
  getEvent,
  getEventCount,
  getEventTypeCounts,
  getEvents,
  getSessionCategories,
  getSessionMetadata,
  getSessionSummary,
  getStatusWindow,
  listSessions,
  searchSessions,
  setArchived,
} from '../session-history/repository.js';
import {
  GREP_ROLES,
  projectGrep,
  projectInputs,
  projectTools,
  projectTranscript,
  projectUsage,
  renderEvent,
  renderGrep,
  renderInputs,
  renderList,
  renderShow,
  renderTools,
  renderTranscript,
  windowItems,
  windowNote,
} from '../session-history/renderer.js';
import type { ListOptions } from '../session-history/repository.js';
import { contextTokensOf } from '../session-history/context-tokens.js';
import type {
  GrepRole,
  ListRenderOptions,
  TranscriptOptions,
  ToolsOptions,
  Window,
} from '../session-history/renderer.js';
import {
  CliUsageError,
  SESSION_VERBS,
  SESSION_VERBS_BY_NAME,
  parseVerbArgs,
  renderSessionHelp,
  renderVerbHelp,
  suggestFlag,
} from './session-cli-spec.js';
import type { ParsedCommand, VerbSpec } from './session-cli-spec.js';

/** Items shown when neither --last nor an explicit --from/--to range is given. */
const DEFAULT_ITEM_CAP = 50;
const DEFAULT_GREP_LIMIT = 50;

function emitJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function fail(message: string): never {
  process.stderr.write(`lattice session: ${message}\n`);
  process.exit(1);
}

function isJson(cmd: ParsedCommand): boolean {
  return cmd.flags.json === true;
}

function str(cmd: ParsedCommand, key: string): string | undefined {
  const value = cmd.flags[key];
  return typeof value === 'string' ? value : undefined;
}

function int(cmd: ParsedCommand, key: string): number | undefined {
  const value = cmd.flags[key];
  return typeof value === 'number' ? value : undefined;
}

function bool(cmd: ParsedCommand, key: string): boolean {
  return cmd.flags[key] === true;
}

/**
 * Every read verb fails loudly on an id we have never seen. Printing
 * "(no transcript content)" and exiting 0 for a typo'd id is the same answer as
 * "this session said nothing", and scripts cannot tell them apart.
 */
function requireConversation(conv: string): void {
  if (!conversationExists(conv)) {
    fail(`no conversation "${conv}" (no metadata and no events). Try: lattice session list`);
  }
}

/**
 * How many items to keep. An explicit --last wins; an explicit --from/--to means
 * the caller already chose a range, so it is honoured whole; otherwise the
 * default cap applies and the renderer reports what it hid.
 */
export function resolveItemLimit(cmd: ParsedCommand): number | undefined {
  const last = int(cmd, 'last');
  if (last !== undefined) return Math.max(0, last);
  if (cmd.flags.from !== undefined || cmd.flags.to !== undefined) return undefined;
  return DEFAULT_ITEM_CAP;
}

function rangeFlags(cmd: ParsedCommand): { fromSeq?: number; toSeq?: number } {
  const out: { fromSeq?: number; toSeq?: number } = {};
  const from = int(cmd, 'from');
  if (from !== undefined) out.fromSeq = from;
  const to = int(cmd, 'to');
  if (to !== undefined) out.toSeq = to;
  return out;
}

/**
 * Notes go to stderr in JSON mode so stdout stays a parseable document, and to
 * stdout in text mode where they read as part of the output.
 */
function reportWindow<T>(window: Window<T>, noun: string, json: boolean): void {
  const note = windowNote(window, noun);
  if (!note) return;
  if (json) process.stderr.write(note + '\n');
  else process.stdout.write(note + '\n');
}

// ---------------------------------------------------------------------------
// Derived status

export type DisplayStatus = 'running' | 'idle' | 'stopping' | 'done';

const DISPLAY_STATUS_BY_ENDPOINT: Record<string, DisplayStatus> = {
  ongoing: 'running',
  idle: 'idle',
  stopping: 'stopping',
  completed: 'done',
};

/**
 * Same events, same derivation the /api/sessions/status endpoint runs, so the
 * CLI and the dashboard cannot disagree about whether a session is running.
 */
export function displayStatusFor(conversationId: string): DisplayStatus {
  const events = getStatusWindow(conversationId);
  const derived = deriveSessionStatusFromEvents(events);
  return DISPLAY_STATUS_BY_ENDPOINT[derived.status] ?? 'done';
}

// ---------------------------------------------------------------------------
// Dates

/** Local midnight today, as epoch ms. */
function startOfToday(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/**
 * `YYYY-MM-DD` means local midnight on that day — `new Date('2026-08-01')`
 * would be UTC midnight, which puts "since today" hours off for anyone west of
 * Greenwich. Anything else is handed to Date as-is.
 */
export function parseSinceDate(input: string, now = new Date()): number | null {
  const trimmed = input.trim();
  if (trimmed.toLowerCase() === 'today') return startOfToday(now);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (ymd) {
    return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])).getTime();
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

// ---------------------------------------------------------------------------
// list

/**
 * With --status we must derive before limiting, or "running" sessions past the
 * first page are invisible. Sessions sort by recent activity and running ones
 * are by definition recent, so a bounded over-fetch is enough.
 */
const STATUS_FILTER_SCAN_MULTIPLIER = 5;
const STATUS_FILTER_MIN_SCAN = 200;

function cmdList(cmd: ParsedCommand): void {
  const limit = int(cmd, 'limit') ?? 30;
  const statusFilter = str(cmd, 'status')?.toLowerCase();
  if (statusFilter && !['running', 'idle', 'stopping', 'done'].includes(statusFilter)) {
    fail(`--status must be one of running, idle, stopping, done (got "${statusFilter}")`);
  }

  const opts: ListOptions = {
    limit: statusFilter
      ? Math.max(limit * STATUS_FILTER_SCAN_MULTIPLIER, STATUS_FILTER_MIN_SCAN)
      : limit,
    includeArchived: bool(cmd, 'all') || bool(cmd, 'archived'),
    onlyArchived: bool(cmd, 'archived'),
  };
  const project = str(cmd, 'project');
  if (project) opts.project = project;
  const tag = str(cmd, 'tag');
  if (tag) opts.tag = tag;

  const since = str(cmd, 'since');
  if (bool(cmd, 'today')) {
    opts.sinceMs = startOfToday();
  }
  if (since) {
    const parsed = parseSinceDate(since);
    if (parsed === null) fail(`--since could not parse "${since}" (expected YYYY-MM-DD or an ISO timestamp)`);
    // --today and --since together: the later floor wins, so both hold.
    opts.sinceMs = opts.sinceMs === undefined ? parsed : Math.max(opts.sinceMs, parsed);
  }

  let items = listSessions(opts);

  const statuses = new Map<string, string>();
  for (const item of items) statuses.set(item.conversationId, displayStatusFor(item.conversationId));

  if (statusFilter) {
    items = items.filter((item) => statuses.get(item.conversationId) === statusFilter).slice(0, limit);
  }

  if (isJson(cmd)) {
    emitJson(items.map((item) => ({ ...item, status: statuses.get(item.conversationId) ?? null })));
    return;
  }
  const renderOpts: ListRenderOptions = { statuses, summaries: bool(cmd, 'summaries') };
  process.stdout.write(renderList(items, renderOpts));
}

// ---------------------------------------------------------------------------
// search

function cmdSearch(cmd: ParsedCommand): void {
  const query = cmd.named.query;
  const limit = int(cmd, 'limit') ?? 30;
  const project = str(cmd, 'project');

  const hits = searchSessions(query, { limit, ...(project ? { project } : {}) });

  if (isJson(cmd)) {
    emitJson(hits);
    return;
  }
  if (hits.length === 0) {
    process.stdout.write(`(no sessions matching ${JSON.stringify(query)})\n`);
    return;
  }
  const lines = hits.map((hit) => {
    const item = hit.item;
    const project = item.summary?.project ? `[${item.summary.project}]` : '';
    const title = item.summary?.title || item.customName || '(untitled)';
    const date = (item.lastActivityAt ?? item.createdAt ?? '').slice(0, 10);
    const archived = item.archived ? ' (archived)' : '';
    return (
      `${date}  ${item.conversationId}  ${project} ${title}${archived}\n` +
      `    ${hit.field}: ${hit.excerpt}`
    );
  });
  process.stdout.write(
    `${hits.length} session${hits.length === 1 ? '' : 's'} matching ${JSON.stringify(query)}\n` +
      lines.join('\n') +
      '\n',
  );
}

// ---------------------------------------------------------------------------
// show

function cmdShow(cmd: ParsedCommand): void {
  const conv = cmd.named.conv;
  requireConversation(conv);

  const metadata = getSessionMetadata(conv);
  const summary = getSessionSummary(conv);
  const eventCount = getEventCount(conv);
  const eventTypeCounts = getEventTypeCounts(conv);
  const usage = projectUsage(getEvents(conv, { types: ['turn:end'] }));
  const contextTokens = contextTokensOf(getEvents(conv, { types: ['turn:end', 'content'] }), metadata?.latestProvider ?? null);
  const status = displayStatusFor(conv);
  const categories = getSessionCategories(conv);

  if (isJson(cmd)) {
    emitJson({ metadata, summary, eventCount, eventTypeCounts, usage, contextTokens, status, categories });
    return;
  }
  process.stdout.write(
    renderShow({ metadata, summary, eventCount, eventTypeCounts, usage, contextTokens, status, categories }),
  );
}

// ---------------------------------------------------------------------------
// transcript / inputs / tools (events-driven)

function cmdInputs(cmd: ParsedCommand): void {
  const conv = cmd.named.conv;
  requireConversation(conv);

  const events = getEvents(conv, { ...rangeFlags(cmd), types: ['input:sent'] });
  const window = windowItems(projectInputs(events), resolveItemLimit(cmd));

  if (isJson(cmd)) {
    emitJson(window.items);
  } else {
    process.stdout.write(renderInputs(window.items));
  }
  reportWindow(window, 'user turns', isJson(cmd));
}

function cmdTranscript(cmd: ParsedCommand): void {
  const conv = cmd.named.conv;
  requireConversation(conv);

  const events = getEvents(conv, { ...rangeFlags(cmd), types: ['input:sent', 'content'] });
  const opts: TranscriptOptions = {
    includeThinking: bool(cmd, 'include-thinking'),
    raw: bool(cmd, 'raw'),
  };
  const window = windowItems(projectTranscript(events, opts), resolveItemLimit(cmd));

  if (isJson(cmd)) {
    emitJson(window.items);
  } else {
    process.stdout.write(renderTranscript(window.items));
  }
  reportWindow(window, 'turns', isJson(cmd));
}

function cmdTools(cmd: ParsedCommand): void {
  const conv = cmd.named.conv;
  requireConversation(conv);

  // Tools needs both content (for tool_use blocks) and result (to map back to results).
  const events = getEvents(conv, { ...rangeFlags(cmd), types: ['content', 'result'] });
  const opts: ToolsOptions = {};
  const name = str(cmd, 'name');
  if (name) opts.nameFilter = name;

  // JSON is read by programs, and a program counting archive calls read the
  // default 50 as the whole list: the note saying what was dropped goes to
  // stderr in JSON mode. So JSON gets every call unless a window was asked for.
  const limit = isJson(cmd) && cmd.flags.last === undefined ? undefined : resolveItemLimit(cmd);
  const window = windowItems(projectTools(events, opts), limit);

  if (isJson(cmd)) {
    emitJson(window.items);
  } else {
    process.stdout.write(renderTools(window.items));
  }
  reportWindow(window, 'tool calls', isJson(cmd));
}

// ---------------------------------------------------------------------------
// event

function cmdEvent(cmd: ParsedCommand): void {
  const conv = cmd.named.conv;
  requireConversation(conv);

  const ref = cmd.named.seq;
  const seq = parseInt(ref, 10);
  if (Number.isNaN(seq)) fail(`event ref "${ref}" is not a valid seq number`);

  const event = getEvent(conv, seq);
  if (!event) fail(`no event found at seq ${seq} in ${conv}`);

  if (isJson(cmd)) {
    emitJson(event);
    return;
  }
  process.stdout.write(renderEvent(event));
}

// ---------------------------------------------------------------------------
// grep

function parseRoles(raw: string | undefined): GrepRole[] | undefined {
  if (!raw) return undefined;
  const requested = raw
    .split(',')
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  const bad = requested.filter((r) => !GREP_ROLES.includes(r as GrepRole));
  if (bad.length > 0) {
    fail(`--role must be one of ${GREP_ROLES.join(', ')} (got "${bad.join(', ')}")`);
  }
  return requested as GrepRole[];
}

function cmdGrep(cmd: ParsedCommand): void {
  const conv = cmd.named.conv;
  requireConversation(conv);
  const query = cmd.named.query;

  const roles = parseRoles(str(cmd, 'role'));
  const limit = int(cmd, 'limit') ?? int(cmd, 'last') ?? DEFAULT_GREP_LIMIT;

  const events = getEvents(conv, { types: ['input:sent', 'content', 'result'] });
  const all = projectGrep(events, query, roles ? { roles } : {});
  const window = windowItems(all, limit);

  if (isJson(cmd)) {
    emitJson({ query, total: window.total, shown: window.items.length, hits: window.items });
    return;
  }
  process.stdout.write(renderGrep(window.items, query, window.total));
}

// ---------------------------------------------------------------------------
// archive / unarchive

function cmdArchive(cmd: ParsedCommand, flag: boolean, label: string): void {
  const conv = cmd.named.conv;
  const changed = setArchived(conv, flag);
  if (!changed) {
    process.stderr.write(`(no session row found for ${conv} — nothing changed)\n`);
    process.exit(1);
  }
  process.stdout.write(`${label}d ${conv}\n`);
}

// ---------------------------------------------------------------------------
// new — create and launch a fresh conversation on the running server

/**
 * The server to dial: the address the server wrote into the agent CLI
 * (agent-cli.ts), else {host, port} from config.json, the file it loads.
 */
export function readServerAddress(): { host: string; port: number } {
  const envPort = Number(process.env.LATTICE_SERVER_PORT);
  if (process.env.LATTICE_SERVER_HOST && Number.isInteger(envPort) && envPort > 0) {
    return { host: process.env.LATTICE_SERVER_HOST, port: envPort };
  }
  const configPath = path.join(CONFIG_DIR, 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const server = (parseJson(raw) as { server?: { host?: string; port?: number } }).server ?? {};
    // 0.0.0.0 is a bind address, not a dial address — reach the local server on loopback.
    const host = !server.host || server.host === '0.0.0.0' ? '127.0.0.1' : server.host;
    return { host, port: server.port ?? 3001 };
  } catch {
    return { host: '127.0.0.1', port: 3001 };
  }
}

// ---------------------------------------------------------------------------
// send — post a message into an existing conversation (resumes it if idle)

async function cmdSend(cmd: ParsedCommand): Promise<void> {
  const conv = cmd.named.conv;
  requireConversation(conv);
  const file = str(cmd, 'message-file');
  const message = file ? fs.readFileSync(file, 'utf-8') : (str(cmd, 'message') ?? cmd.named.message ?? '');
  const address = readServerAddress();
  const result = await sendSessionMessage({
    host: str(cmd, 'host') ?? address.host,
    port: int(cmd, 'port') ?? address.port,
    conversationId: conv,
    message,
    model: str(cmd, 'model'),
    from: str(cmd, 'from'),
    summary: str(cmd, 'summary'),
    task: str(cmd, 'task'),
    thread: int(cmd, 'thread'),
    passedOn: bool(cmd, 'passed-on'),
    answers: int(cmd, 'answers'),
    interrupt: bool(cmd, 'interrupt'),
    afterTurn: bool(cmd, 'after-turn'),
  }).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
  if (isJson(cmd)) emitJson(result);
  else {
    // `saved` is the route's word for "in the inbox, not delivered when it
    // should have been"; its note says why (routes.ts, SendDelivery).
    // `immediate` is on the receipt when the message went (or tried to go)
    // into a running turn rather than waiting for it to end.
    const immediate = result.immediate as { status?: string } | undefined;
    const when = result.delivery === 'after-turn'
      ? result.afterTurn === true
        ? 'It is mid-turn and will read this when that turn ends, as asked.'
        : typeof result.note === 'string'
          ? result.note
          : 'It is mid-turn and will read this after finishing (use --interrupt to cancel that turn first).'
      : result.delivery === 'saved'
        ? (typeof result.note === 'string' ? result.note : 'It was saved to the inbox but not delivered now.')
        : result.interrupted === true
          ? 'Its running turn was cancelled and it is reading this now.'
          : immediate?.status === 'delivered'
            ? 'It is mid-turn; the provider took this into the running turn, and it reads it at its next input point without its current tool being cancelled. Not yet read.'
            : 'It will read this now.';
    process.stdout.write(`Message accepted by ${conv}. ${when} Read the reply with lattice session transcript ${conv} --last 10\n`);
  }
}

// ---------------------------------------------------------------------------
// Unread messages — what a session has been sent and no turn has taken yet

/** Rough age, for a line a coordinator reads rather than measures. */
function ageSince(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h${String(Math.round((seconds % 3600) / 60)).padStart(2, '0')}`;
}

/**
 * One line for what is queued at a session. Queued and read are all this
 * knows: read means a turn was handed the message, not that the worker
 * understood it or acted on it, so the wording says read and nothing more.
 * Empty when nothing is waiting, or when the server did not send the field.
 */
function renderUnread(summary: UnreadInboxSummary | undefined): string {
  if (!summary || summary.count < 1) return '';
  const what = summary.count === 1 ? '1 message' : `${summary.count} messages`;
  const whose = summary.fromYou === 0
    ? 'none from you'
    : summary.fromYou === summary.count
      ? (summary.count === 1 ? 'from you' : 'all from you')
      : `${summary.fromYou} from you`;
  const when = summary.count === 1 ? 'sent' : 'oldest sent';
  return `${what} not read yet (${whose}) · ${when} ${ageSince(summary.oldestAt)} ago`;
}

// ---------------------------------------------------------------------------
// note / state — a coordinator's project state, kept by the server

async function projectRequest(cmd: ParsedCommand, conv: string, path: string, init?: RequestInit): Promise<ProjectStateResponse> {
  return (await projectRequestWithArchived(cmd, conv, path, init)).state;
}

/** The same request, plus the workers the server archived because of it (a note that dealt with their reports). */
async function projectRequestWithArchived(cmd: ParsedCommand, conv: string, path: string, init?: RequestInit): Promise<{
  state: ProjectStateResponse;
  archivedWorkers: Array<{ worker: string; reason: string }>;
}> {
  const address = readServerAddress();
  const host = str(cmd, 'host') ?? address.host;
  const port = int(cmd, 'port') ?? address.port;
  const response = await fetch(`http://${host}:${port}/api/conv/${encodeURIComponent(conv)}/project${path}`, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), ...serverAuthHeaders() },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`server rejected the request (HTTP ${response.status}): ${text}`);
  const result = parseJson(text) as { state?: ProjectStateResponse; archivedWorkers?: Array<{ worker: string; reason: string }> } | ProjectStateResponse;
  if ('state' in result && result.state) return { state: result.state, archivedWorkers: result.archivedWorkers ?? [] };
  return { state: result as ProjectStateResponse, archivedWorkers: [] };
}

/** `--owner`: `you`/`front` is the coordinator, `user` is the user, a conv id is that worker, anything else is a name. */
function parseOwnerFlag(raw: string): ThreadOwner {
  const value = raw.trim();
  const lower = value.toLowerCase();
  if (lower === 'you' || lower === 'me' || lower === 'front' || lower === 'coordinator') return { kind: 'coordinator' };
  if (lower === 'user') return { kind: 'user' };
  // The user's own name used to be the spelling; taken as a name it would make a
  // separate owner that only looks like the user.
  if (lower === userName().toLowerCase()) fail(`--owner ${value} is now --owner user`);
  if (value.startsWith('conv-')) return { kind: 'worker', worker: value };
  return { kind: 'external', who: value };
}

/** `--waiting-on worker:conv-x is running the migration` — the kind, then why, in the coordinator's own words. */
function parseWaitFlag(raw: string): ThreadWait {
  const separator = raw.indexOf(':');
  const kind = (separator >= 0 ? raw.slice(0, separator) : '').trim().toLowerCase();
  const text = (separator >= 0 ? raw.slice(separator + 1) : raw).trim();
  if (!(THREAD_WAIT_KINDS as readonly string[]).includes(kind)) {
    fail(`--waiting-on must start with ${THREAD_WAIT_KINDS.join(' | ')} then ":" and why, e.g. --waiting-on "worker:conv-abc is verifying"`);
  }
  if (!text) fail('--waiting-on needs a reason after the ":"');
  const worker = text.split(/[\s,]+/).find((word) => word.startsWith('conv-'));
  const threadRef = kind === 'dependency' ? Number(text) : NaN;
  return {
    kind: kind as ThreadWait['kind'],
    text,
    ...(worker ? { worker } : {}),
    ...(Number.isInteger(threadRef) ? { thread: threadRef } : {}),
  };
}

/** `--replaces 412,415` / `--retire 412`: decision seqs, which `state` prints in brackets. */
function parseDecisionSeqs(raw: string, flag: string): number[] {
  const seqs = raw.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const seq = Number(entry);
    if (!Number.isInteger(seq)) fail(`${flag} takes the decision seqs \`state\` prints in brackets, got "${entry}"`);
    return seq;
  });
  if (seqs.length === 0) fail(`${flag} needs at least one decision seq`);
  return seqs;
}

/** `--rank 1337,5987,6071`: open thread ids, most important first. */
function parseThreadIds(raw: string): number[] {
  const ids = raw.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const id = Number(entry.replace(/^\[|\]$/g, ''));
    if (!Number.isInteger(id)) fail(`--rank takes the thread ids \`state\` prints in brackets, got "${entry}"`);
    return id;
  });
  if (ids.length === 0) fail('--rank needs at least one thread id');
  return ids;
}

/** `--addresses 412,415` or `--addresses conv-abc`; the server resolves a worker id against the thread being changed. */

function parseAddressesFlag(raw: string): Array<number | string> {
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    if (entry.startsWith('conv-')) return entry;
    const seq = Number(entry);
    if (!Number.isInteger(seq)) fail(`--addresses takes event seqs or worker conv ids, got "${entry}"`);
    return seq;
  });
}

async function cmdNote(cmd: ParsedCommand): Promise<void> {
  const conv = cmd.named.conv;
  requireConversation(conv);
  const notes: ProjectNotedData[] = [];
  const outcome = str(cmd, 'outcome');
  const name = str(cmd, 'name');
  if (name && !outcome) fail('--name goes with --outcome: a project is named for the outcome it was agreed for');
  if (outcome) notes.push({ kind: 'outcome', text: outcome, by: 'coordinator', ...(name ? { name } : {}) });
  const decide = str(cmd, 'decide');
  const replaces = str(cmd, 'replaces');
  if (replaces && !decide) fail('--replaces says what a new decision supersedes; withdraw one on its own with --retire <seqs> --with "<why>"');
  if (decide) {
    notes.push({
      kind: 'decision',
      text: decide,
      by: bool(cmd, 'by-user') ? 'user' : 'coordinator',
      ...(replaces ? { supersedes: parseDecisionSeqs(replaces, '--replaces') } : {}),
    });
  }


  // The structured half of a thread. The same flags describe a thread being
  // opened and a thread being updated, because an update is the same thing
  // said again about work whose id has not changed.
  const owner = str(cmd, 'owner');
  const next = str(cmd, 'next');
  const waitingOn = str(cmd, 'waiting-on');
  const ready = bool(cmd, 'ready');
  const worker = str(cmd, 'worker');
  const addresses = str(cmd, 'addresses');
  const summary = str(cmd, 'summary');
  const evidence = str(cmd, 'evidence');
  const label = str(cmd, 'label');
  if (waitingOn && ready) fail('--waiting-on and --ready contradict each other; pass one');
  // `--with` is the evidence line, and each of these wants its own.
  const usesWith = [
    int(cmd, 'close') !== undefined,
    int(cmd, 'park') !== undefined,
    Boolean(str(cmd, 'reconcile')),
    Boolean(str(cmd, 'retire')),
    bool(cmd, 'account-from-now'),
  ].filter(Boolean).length;
  if (usesWith > 1) fail('--close, --park, --retire, --reconcile and --account-from-now each take their own --with; make them separate calls');
  const fields = {
    ...(owner ? { owner: parseOwnerFlag(owner) } : {}),
    ...(next ? { nextAction: next } : {}),
    ...(waitingOn ? { waitingOn: parseWaitFlag(waitingOn) } : ready ? { waitingOn: null } : {}),
    ...(worker ? { workers: [worker] } : {}),
    ...(evidence ? { evidence: [evidence] } : {}),
    ...(label ? { label } : {}),
  };

  const open = str(cmd, 'open');
  // A thread being opened has no progress to summarise; its text is what the
  // work is for, and the first --thread update is where it says where it got to.
  if (open && summary) fail('--summary says where an existing thread has got to; --open states what the new thread is for');
  if (open) notes.push({ kind: 'open', text: open, by: 'coordinator', ...fields });

  const thread = int(cmd, 'thread');
  // Only when it actually says something. `--thread` also binds a --priority
  // to a thread and scopes a --reconcile, and neither is an update.
  const updatesThread = thread !== undefined
    && (Object.keys(fields).length > 0 || Boolean(addresses) || Boolean(summary));
  if (updatesThread) {
    notes.push({
      kind: 'update',
      text: summary ?? '',
      by: 'coordinator',
      ref: thread,
      ...fields,
      ...(addresses ? { addresses: parseAddressesFlag(addresses) as number[] } : {}),
    });
  }
  const retire = str(cmd, 'retire');
  if (retire) {
    const why = str(cmd, 'with');
    if (!why) fail('--retire needs --with "<why it no longer applies>"; a decision withdrawn without a reason cannot be read back');
    notes.push({ kind: 'retire', text: why, by: 'coordinator', supersedes: parseDecisionSeqs(retire, '--retire') });
  }
  const priority = str(cmd, 'priority');
  if (priority) {
    notes.push({
      kind: 'priority',
      text: priority,
      by: 'coordinator',
      ...(thread !== undefined ? { ref: thread } : {}),
    });
  }

  const close = int(cmd, 'close');
  if (close !== undefined) {
    notes.push({
      kind: 'close',
      text: str(cmd, 'with') ?? '',
      by: 'coordinator',
      ref: close,
      ...(addresses && !updatesThread ? { addresses: parseAddressesFlag(addresses) as number[] } : {}),
    });
  }
  const park = int(cmd, 'park');
  if (park !== undefined) {
    const why = str(cmd, 'with');
    if (!why) fail('--park needs --with "<why it is parked and what would bring it back>"');
    notes.push({ kind: 'park', text: why, by: 'coordinator', ref: park });
  }
  const unpark = int(cmd, 'unpark');
  if (unpark !== undefined) notes.push({ kind: 'unpark', text: '', by: 'coordinator', ref: unpark });
  const accountFrom = bool(cmd, 'account-from-now');
  if (accountFrom) {
    notes.push({
      kind: 'accounting',
      text: str(cmd, 'with') ?? 'Accounting for worker reports and questions starts here.',
      by: 'coordinator',
    });
  }

  // Reconciling is the only way a report from before the boundary gets a
  // disposition, and it takes the seqs one at a time with what happened.
  const reconcile = str(cmd, 'reconcile');
  if (reconcile) {
    const disposition = str(cmd, 'as');
    if (!disposition || !(RECONCILE_DISPOSITIONS as readonly string[]).includes(disposition)) {
      fail(`--as must be one of ${RECONCILE_DISPOSITIONS.join(' | ')}: what you found when you looked at it`);
    }
    const evidence = str(cmd, 'with');
    if (!evidence) fail('--reconcile needs --with "<what actually happened to it>"; a disposition without evidence is a guess');
    notes.push({
      kind: 'reconcile',
      text: evidence,
      by: 'coordinator',
      disposition: disposition as ProjectNotedData['disposition'],
      addresses: parseAddressesFlag(reconcile).map((entry) => {
        if (typeof entry !== 'number') fail(`--reconcile takes event seqs, not a worker id: "${entry}"`);
        return entry as number;
      }),
      ...(thread !== undefined ? { ref: thread } : {}),
    });
  }

  const rank = str(cmd, 'rank');
  if (rank) notes.push({ kind: 'rank', text: '', by: 'coordinator', order: parseThreadIds(rank) });

  const now = str(cmd, 'now');
  if (now) notes.push({ kind: 'now', text: now, by: 'coordinator' });
  if (notes.length === 0) {
    fail('note needs at least one of --outcome, --priority, --rank, --decide, --retire, --open, --thread, --close, --park, --unpark, --now, --reconcile, --account-from-now');
  }

  if (open && thread !== undefined) fail('--open starts a new thread and --thread updates an existing one; pass one');

  let state: ProjectState | undefined;
  const archived: Array<{ worker: string; reason: string }> = [];
  for (const note of notes) {
    const result = await projectRequestWithArchived(cmd, conv, '/note', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(note),
    });
    state = result.state;
    archived.push(...result.archivedWorkers);
  }
  if (isJson(cmd)) emitJson(state);
  else {
    process.stdout.write(`Noted. Project state for ${conv}:\n${renderProjectState(state!, { userName: userName(), now: Date.now() })}\n`);
    // Said so the coordinator does not archive them again by hand, and knows
    // a send brings any of them back.
    if (archived.length > 0) {
      process.stdout.write(`\nArchived, their work being done (a send brings one back): ${archived.map((entry) => entry.worker).join(', ')}\n`);
    }
  }
}

async function cmdState(cmd: ParsedCommand): Promise<void> {
  const conv = cmd.named.conv;
  requireConversation(conv);
  const state = await projectRequest(cmd, conv, '');
  if (isJson(cmd)) emitJson(state);
  // The default is the active record, the same text the server puts in front
  // of a project turn. --history adds what is no longer in force.
  else process.stdout.write(`${renderProjectState(state, { history: bool(cmd, 'history'), cli: latticeCli(), conversationId: conv, userName: userName(), now: Date.now() })}${renderUnreadSection(state.unread)}\n`);
}

/**
 * Appended to the written state: the workers carrying open threads that have
 * something queued. A server that predates the field sends none, and then
 * this says nothing rather than claiming everything has been read.
 */
function renderUnreadSection(unread: Record<string, UnreadInboxSummary> | undefined): string {
  const waiting = Object.entries(unread ?? {}).filter(([, summary]) => summary.count > 0);
  if (waiting.length === 0) return '';
  waiting.sort((a, b) => a[1].oldestAt - b[1].oldestAt);
  const lines = waiting.map(([worker, summary]) => `- ${worker}: ${renderUnread(summary)}`);
  return `\nStill waiting to be read (they are queued, not acted on):\n${lines.join('\n')}`;
}


/**
 * The coordinator's roster, from the same endpoint the panel reads. A worker
 * runs this to see its colleagues; front runs it to see what it has out.
 */
async function cmdWorkers(cmd: ParsedCommand): Promise<void> {
  const conv = cmd.named.conv;
  requireConversation(conv);
  const address = readServerAddress();
  const host = str(cmd, 'host') ?? address.host;
  const port = int(cmd, 'port') ?? address.port;
  const response = await fetch(`http://${host}:${port}/api/conv/${encodeURIComponent(conv)}/workers`, { headers: serverAuthHeaders() });
  const text = await response.text();
  if (!response.ok) throw new Error(`server rejected the request (HTTP ${response.status}): ${text}`);
  const payload = parseJson(text) as WorkersResponse;
  if (isJson(cmd)) {
    emitJson(payload);
    return;
  }
  if (payload.workers.length === 0) {
    process.stdout.write(`${conv} has dispatched no workers.\n`);
    return;
  }
  const lines = payload.workers.map((worker) => {
    const who = [worker.worker, worker.provider, worker.model, worker.thread !== null ? `thread [${worker.thread}]` : null]
      .filter(Boolean).join(' · ');
    const waitingOn = workerWaitingOn(worker);
    const standing = worker.archived
      ? 'archived'
      : waitingOn
        ? `waiting on ${waitingOn}${worker.phase !== 'reported' || worker.reportReached ? '' : ' (not read yet)'}`
      : worker.phase === 'asked'
        ? 'waiting on an answer'
        // A reported worker that is running again falls through to the
        // runtime word below: the report was true when it was written and
        // nothing in the coordinator's log records the restart, so `reported`
        // on its own would describe a worker mid-turn as finished.
        : worker.phase === 'reported' && !workerResumedAfterReport(worker)
          ? `reported${worker.reportReached ? '' : ' (not read yet)'}`
          // Was `worker.activity ?? 'working'`, which printed the literal
          // word for a process that had exited — the endpoint stops serving
          // an activity phrase once a worker is no longer working, so the
          // fallback was doing all the work and it was wrong. Same mapping as
          // the panel, so the roster and the card cannot say different things
          // about the same worker.
          : worker.activity ?? workerRuntimeWord(worker).toLowerCase();
    const waiting = renderUnread(payload.unread?.[worker.worker]);
    return `${who}\n  ${worker.task}\n  ${standing}${waiting ? `\n  ${waiting}` : ''}`;
  });
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function cmdNew(cmd: ParsedCommand): Promise<void> {
  // Prompt: --prompt-file wins (reads a brief from disk), else --prompt/--message,
  // else the trailing positional. A first turn must carry text here — the CLI does
  // not do attachment-only launches.
  let prompt: string | undefined;
  const promptFile = str(cmd, 'prompt-file');
  if (promptFile) {
    try {
      prompt = fs.readFileSync(promptFile, 'utf-8');
    } catch (err) {
      fail(`could not read --prompt-file: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    prompt = str(cmd, 'prompt') ?? str(cmd, 'message') ?? cmd.named.prompt;
  }
  if (!prompt || prompt.trim() === '') {
    fail('new requires a prompt (positional text, --prompt "…", or --prompt-file PATH)');
  }

  const model = str(cmd, 'model');
  const from = str(cmd, 'from');
  const task = str(cmd, 'task');
  const thread = int(cmd, 'thread');
  const coordinator = bool(cmd, 'coordinator');
  const providerFlag = str(cmd, 'provider');
  if (providerFlag && providerFlag !== 'claude' && providerFlag !== 'codex') {
    fail(`--provider must be claude or codex, got "${providerFlag}"`);
  }
  // A coordinator with no --provider is left to the server, which starts it on
  // the configured coordinator provider (coordinator-defaults.ts).
  const provider = providerFlag ?? (coordinator ? undefined : 'claude');
  // Codex reads effort; Claude has no equivalent, so naming one there is a
  // silently ignored flag rather than a setting. The create route already
  // accepted this — the CLI was the only supported way to dispatch and it
  // could not send it, so an Astra assignment took the configured default
  // whatever the work needed.
  const reasoningEffort = str(cmd, 'reasoning-effort');
  if (reasoningEffort && provider && provider !== 'codex') {
    fail(`--reasoning-effort is a Codex setting; --provider ${provider} has none`);
  }

  const cwdFlag = str(cmd, 'cwd');
  // A worker picked up from a parent lands in the parent's cwd; the server
  // resolves that, so only send a cwd when one was actually named.
  const workingDirectory = cwdFlag !== undefined || !from
    ? (cwdFlag ?? process.cwd()).replace(/^~(?=$|\/)/, process.env.HOME ?? '~')
    : undefined;
  const workspace = str(cmd, 'workspace');
  const permissionMode = str(cmd, 'permission-mode');

  const address = readServerAddress();
  const host = str(cmd, 'host') ?? address.host;
  const port = int(cmd, 'port') ?? address.port;

  const body: Record<string, unknown> = {
    ...(provider ? { provider } : {}),
    message: prompt,
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(from ? { pickedUpFrom: from } : {}),
    ...(from && task ? { task } : {}),
    ...(from && thread !== undefined ? { thread } : {}),
    ...(coordinator ? { coordinator: true } : {}),
    ...(bool(cmd, 'archived') ? { archived: true } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(workspace ? { workspace } : {}),
    ...(permissionMode ? { permissionMode } : {}),
  };


  const url = `http://${host}:${port}/api/conv/create`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...serverAuthHeaders() },
      body: JSON.stringify(body),
    });
  } catch (err) {
    fail(
      `could not reach the Lattice server at ${host}:${port} ` +
        `(${err instanceof Error ? err.message : String(err)}). Is it running? Try: pnpm service:status`,
    );
  }

  const text = await res.text();
  let payload: unknown;
  try {
    payload = text ? parseJson(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!res.ok) {
    const errMsg =
      (payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : undefined) ?? `HTTP ${res.status}`;
    fail(`server rejected create: ${errMsg}`);
  }

  if (isJson(cmd)) {
    emitJson(payload);
    return;
  }

  const conversationId =
    payload && typeof payload === 'object' && 'conversationId' in payload
      ? String((payload as { conversationId: unknown }).conversationId)
      : undefined;
  if (conversationId) {
    process.stdout.write(`${conversationId}\n`);
    process.stdout.write(`  model:   ${model ?? '(server default)'}\n`);
    process.stdout.write(`  cwd:     ${workingDirectory ?? `(inherited from ${from})`}\n`);
    process.stdout.write(`  open:    http://${host}:${port}/c/${conversationId}\n`);
  } else {
    emitJson(payload);
  }
}

async function cmdSwitch(cmd: ParsedCommand): Promise<void> {
  const conv = cmd.named.conv;
  const provider = str(cmd, 'provider');
  const model = str(cmd, 'model');
  if (!provider || !model) fail('switch requires --provider and --model');
  const address = readServerAddress();
  const host = str(cmd, 'host') ?? address.host;
  const port = int(cmd, 'port') ?? address.port;
  let response: Response;
  try {
    response = await fetch(`http://${host}:${port}/api/conv/${encodeURIComponent(conv)}/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...serverAuthHeaders() },
      body: JSON.stringify({ provider, model }),
    });
  } catch (err) {
    fail(`could not reach the Lattice server at ${host}:${port} (${err instanceof Error ? err.message : String(err)})`);
  }
  const text = await response.text();
  let payload: Record<string, unknown>;
  try {
    payload = parseJson(text) as Record<string, unknown>;
  } catch {
    fail(`server answered HTTP ${response.status}: ${text}`);
  }
  if (isJson(cmd)) {
    emitJson(payload);
  } else if (payload.status === 'switched') {
    const to = payload.to as { provider: string; model: string };
    process.stdout.write(`${conv} switched to ${to.provider} ${to.model}. Its reply: ${String(payload.reply)}\n`);
  } else if (payload.status === 'unchanged') {
    process.stdout.write(`${conv} is already on ${String(payload.provider)} ${String(payload.model)}; nothing changed.\n`);
  } else if (payload.status === 'refused') {
    process.stderr.write(`switch refused (${String(payload.code)}): ${String(payload.reason)}\n`);
  } else if (payload.status === 'rolled-back') {
    process.stderr.write(`${conv} had an unfinished switch; it was undone and ${String(payload.provider)} ${String(payload.model)} is running again. Nothing was switched: run the same command again to switch.\n`);
    process.exitCode = 1;
  } else if (payload.status === 'failed') {
    process.stderr.write(`switch failed: ${String(payload.error)}. ${payload.restored ? 'The previous provider was started again.' : `The previous provider did NOT restart, so sends to ${conv} stay blocked; run this command again to retry the undo.`}\n`);
  } else {
    process.stderr.write(`server answered HTTP ${response.status}: ${text}\n`);
  }
  if (!response.ok) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// compact

async function cmdCompact(cmd: ParsedCommand): Promise<void> {
  const conv = cmd.named.conv;
  const address = readServerAddress();
  let result: Record<string, unknown>;
  try {
    result = await compactSession({ host: str(cmd, 'host') ?? address.host, port: int(cmd, 'port') ?? address.port, conversationId: conv });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (isJson(cmd)) emitJson(result);
  else process.stdout.write(`Compaction started for ${conv}. Its transcript shows when it has finished: lattice session transcript ${conv} --last 3\n`);
}

async function cmdReact(cmd: ParsedCommand): Promise<void> {
  const conv = cmd.named.conv;
  const address = readServerAddress();
  let result: Record<string, unknown>;
  try {
    result = await reactToUsersMessage({
      host: str(cmd, 'host') ?? address.host,
      port: int(cmd, 'port') ?? address.port,
      conversationId: conv,
      emoji: cmd.named.emoji,
      remove: bool(cmd, 'remove'),
      messageId: str(cmd, 'message'),
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (isJson(cmd)) {
    emitJson(result);
    return;
  }
  const said = result.status === 'added' ? `Reacted ${cmd.named.emoji} to`
    : result.status === 'removed' ? `Took ${cmd.named.emoji} off`
      : `${cmd.named.emoji} was already ${bool(cmd, 'remove') ? 'off' : 'on'}`;
  process.stdout.write(`${said} the user's message ${String(result.messageId)}: "${String(result.text)}"\n`);
}

const PERMISSION_ACTIONS: Record<string, 'approve' | 'deny' | 'escalate'> = { allow: 'approve', deny: 'deny', escalate: 'escalate' };

async function cmdPermission(cmd: ParsedCommand): Promise<void> {
  const id = cmd.named.id;
  const action = PERMISSION_ACTIONS[cmd.named.action];
  if (!action) fail(`permission takes allow, deny or escalate, got "${cmd.named.action}"`);
  const from = str(cmd, 'from');
  if (!from) fail('permission needs --from <your own conversation id>');
  const reason = str(cmd, 'reason');
  if (action === 'escalate' && !reason) fail('escalate needs --reason "<one plain sentence for the user>"');
  const address = readServerAddress();
  const host = str(cmd, 'host') ?? address.host;
  const port = int(cmd, 'port') ?? address.port;
  const response = await fetch(`http://${host}:${port}/api/permissions/${encodeURIComponent(id)}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...serverAuthHeaders() },
    body: JSON.stringify({
      action,
      from,
      ...(action === 'deny' && reason ? { denyReason: reason } : {}),
      ...(action === 'escalate' ? { why: reason } : {}),
    }),
  });
  const text = await response.text();
  if (!response.ok) fail(`permission refused (HTTP ${response.status}): ${text}`);
  if (isJson(cmd)) {
    emitJson(parseJson(text));
    return;
  }
  const said = action === 'approve' ? 'Allowed; the worker carries on.'
    : action === 'deny' ? 'Denied; the worker is told why.'
      : 'Handed to the user; they are asked in your thread and notified.';
  process.stdout.write(`${said}\n`);
}

// ---------------------------------------------------------------------------
// move-worker / move-thread — splitting a project

interface MovedWorker { worker: string; from: string; to: string; thread: number | null; copied: Array<{ from: number; to: number }>; warnings: string[]; midTurn: boolean }

async function moveRequest(cmd: ParsedCommand, url: string, body: unknown): Promise<Record<string, unknown>> {
  const address = readServerAddress();
  const host = str(cmd, 'host') ?? address.host;
  const port = int(cmd, 'port') ?? address.port;
  const response = await fetch(`http://${host}:${port}/api/conv/${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...serverAuthHeaders() },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) fail(`move refused (HTTP ${response.status}): ${text}`);
  return parseJson(text) as Record<string, unknown>;
}

/**
 * A worker moved in the middle of a turn still thinks it works for the old
 * project, and it reads a message at its next input point, so it is told.
 * One that is idle is not: a message would start it up just to acknowledge.
 */
async function tellMovedWorker(cmd: ParsedCommand, moved: MovedWorker): Promise<string> {
  if (!moved.midTurn) return `${moved.worker} is not in a turn, so it was not messaged; ${moved.to}'s next message reaches it.`;
  const address = readServerAddress();
  const cli = latticeCli();
  await sendSessionMessage({
    host: str(cmd, 'host') ?? address.host,
    port: int(cmd, 'port') ?? address.port,
    conversationId: moved.worker,
    from: moved.to,
    summary: `Moved into this project from ${moved.from}`,
    message: `Lattice moved you from project ${moved.from} to project ${moved.to} (\`session move-worker\`). `
      + `Carry on with what you are doing; your reports and questions now go to ${moved.to}, and its record is \`${cli} session state ${moved.to}\`.`
      + (moved.thread !== null ? ` Your thread there is [${moved.thread}].` : ''),
  });
  return `${moved.worker} is mid-turn and was told where it now reports.`;
}

function renderMovedWorker(moved: MovedWorker): string {
  const lines = [`Moved ${moved.worker} from ${moved.from} to ${moved.to}${moved.thread !== null ? `, on thread [${moved.thread}]` : ''}.`];
  if (moved.copied.length > 0) {
    lines.push(`  Still owed a disposition, now in ${moved.to}: ${moved.copied.map((pair) => `[${pair.to}] (was [${pair.from}])`).join(', ')}`);
  }
  for (const warning of moved.warnings) lines.push(`  Not changed: ${warning}`);
  return lines.join('\n');
}

async function cmdMoveWorker(cmd: ParsedCommand): Promise<void> {
  const worker = cmd.named.conv;
  const from = str(cmd, 'from');
  const to = str(cmd, 'to');
  if (!from || !to) fail('move-worker needs --from <the coordinator it reports to> and --to <the one it is to report to>');
  const thread = int(cmd, 'thread');
  const moved = await moveRequest(cmd, `${encodeURIComponent(worker)}/move`, { from, to, ...(thread !== undefined ? { thread } : {}) }) as unknown as MovedWorker;
  const told = await tellMovedWorker(cmd, moved);
  if (isJson(cmd)) emitJson({ ...moved, told });
  else process.stdout.write(`${renderMovedWorker(moved)}\n  ${told}\n`);
}

async function cmdMoveThread(cmd: ParsedCommand): Promise<void> {
  const seq = Number(cmd.named.seq);
  if (!Number.isInteger(seq)) fail(`move-thread takes a thread seq, got "${cmd.named.seq}"`);
  const from = str(cmd, 'from');
  const to = str(cmd, 'to');
  if (!from || !to) fail('move-thread needs --from <the coordinator whose record has it> and --to <the one to move it to>');
  const moved = await moveRequest(cmd, `${encodeURIComponent(from)}/project/threads/${seq}/move`, { to }) as unknown as {
    thread: number; newThread: number; copied: Array<{ from: number; to: number }>; workers: MovedWorker[]; warnings: string[];
  };
  const told: string[] = [];
  for (const worker of moved.workers) told.push(await tellMovedWorker(cmd, worker));
  if (isJson(cmd)) {
    emitJson({ ...moved, told });
    return;
  }
  const lines = [`Moved thread [${seq}] from ${from} to ${to}, where it is [${moved.newThread}]. ${from} records it closed as moved.`];
  if (moved.copied.length > 0) {
    lines.push(`  Still owed a disposition, now in ${to}: ${moved.copied.map((pair) => `[${pair.to}] (was [${pair.from}])`).join(', ')}`);
  }
  for (const worker of moved.workers) lines.push(`  ${renderMovedWorker(worker).split('\n')[0]}`);
  for (const line of told) lines.push(`  ${line}`);
  for (const warning of moved.warnings) lines.push(`  Not changed: ${warning}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// Dispatch

const HANDLERS = new Map<string, (cmd: ParsedCommand) => void | Promise<void>>([
  ['new', cmdNew],
  ['send', cmdSend],
  ['list', cmdList],
  ['show', cmdShow],
  ['search', cmdSearch],
  ['inputs', cmdInputs],
  ['transcript', cmdTranscript],
  ['tools', cmdTools],
  ['event', cmdEvent],
  ['grep', cmdGrep],
  ['archive', (cmd) => cmdArchive(cmd, true, 'archive')],
  ['unarchive', (cmd) => cmdArchive(cmd, false, 'unarchive')],
  ['note', cmdNote],
  ['state', cmdState],
  ['workers', cmdWorkers],
  ['switch', cmdSwitch],
  ['move-worker', cmdMoveWorker],
  ['move-thread', cmdMoveThread],
  ['compact', cmdCompact],
  ['react', cmdReact],
  ['permission', cmdPermission],
]);

/** Verbs that are pure HTTP clients to the running server and open no SQLite connection. */
const HTTP_VERBS = new Set(['new', 'note', 'state', 'workers', 'switch', 'move-worker', 'move-thread', 'compact', 'react', 'permission']);

/** Verbs that only read, and so can open SQLite read-only. */
const MUTATING_VERBS = new Set(['archive', 'unarchive']);

export function runSessionCommand(args: string[]): void {
  const verb = args[0];

  if (verb === '--help' || verb === '-h' || verb === 'help') {
    process.stdout.write(renderSessionHelp());
    return;
  }
  if (!verb) {
    // A usage error, so it goes to stderr and exits non-zero — `lattice session`
    // with no verb did nothing the caller asked for.
    process.stderr.write('lattice session: missing subcommand\n\n');
    process.stderr.write(renderSessionHelp());
    process.exit(1);
  }

  const spec: VerbSpec | undefined = SESSION_VERBS_BY_NAME.get(verb);
  if (!spec) {
    const suggestion = suggestFlag(verb, SESSION_VERBS.map((v) => v.name));
    process.stderr.write(
      `lattice session: unknown subcommand "${verb}"` +
        (suggestion ? ` (did you mean "${suggestion}"?)` : '') +
        '\n\n',
    );
    process.stderr.write(renderSessionHelp());
    process.exit(1);
  }

  // `--by-user` used to be spelled with the user's name, and coordinators briefed
  // before the rename still write it; name the replacement rather than "unknown flag".
  const byName = `--by-${userName().toLowerCase()}`;
  if (spec.flags.some((f) => f.name === 'by-user') && args.slice(1).some((a) => a.toLowerCase() === byName)) {
    fail(`${byName} is now --by-user`);
  }

  let cmd: ParsedCommand;
  try {
    cmd = parseVerbArgs(spec, args.slice(1));
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`lattice session: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  if (cmd.helpRequested) {
    process.stdout.write(renderVerbHelp(spec));
    return;
  }

  const handler = HANDLERS.get(verb)!;

  // HTTP-only verbs open no SQLite connection, so skip DB init entirely
  // (and let their promise reject loudly).
  if (HTTP_VERBS.has(verb)) {
    void Promise.resolve(handler(cmd)).catch((err: unknown) => {
      process.stderr.write(`lattice session: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
    return;
  }

  // Pre-init the DatabaseProvider singleton in the right mode for this verb.
  // Read verbs use a readonly connection so the CLI works under read-only
  // sandboxes (codex `--sandbox read-only`, etc.) where the WAL `-shm` and
  // `journal_mode = WAL` writes the default open path performs would fail.
  // Mutating verbs (archive/unarchive) need a writable connection.
  if (MUTATING_VERBS.has(verb)) {
    DatabaseProvider.getInstance();
  } else {
    DatabaseProvider.getInstance(undefined, { readonly: true });
  }

  void handler(cmd);
}
