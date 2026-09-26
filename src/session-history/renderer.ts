/**
 * Pure projection + formatting for the read-only session browsing surface.
 * Consumed by both the CLI subcommands and the HTTP routes.
 *
 * Shape of the pipeline: `project*` turns raw events into items, `windowItems`
 * trims them to what was asked for, `render*` formats the items. Keeping the
 * window between projection and rendering is what lets `--last 1` mean "one
 * user turn" rather than "one event".
 */

import { formatContextTokens } from './context-tokens.js';
import type {
  RawEvent,
  SessionCategories,
  SessionListItem,
  SessionMetadata,
  SessionSummaryRow,
  ToolCall,
  TranscriptLine,
  UsageTotals,
} from './types.js';

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
}

interface InputSentData {
  text: string;
}

function asContentBlocks(data: unknown): ContentBlock[] {
  if (data && typeof data === 'object' && 'blocks' in data) {
    const blocks = (data as { blocks: unknown }).blocks;
    if (Array.isArray(blocks)) {
      return blocks as ContentBlock[];
    }
  }
  return [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/** The message a content event belongs to, used to rejoin streamed tokens. */
function messageIdOf(event: RawEvent): string | null {
  const data = event.data;
  if (data && typeof data === 'object' && 'messageId' in data) {
    return asString((data as { messageId: unknown }).messageId);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Windowing

export interface Window<T> {
  items: T[];
  total: number;
  /** How many items were dropped off the front to satisfy the limit. */
  dropped: number;
}

/** Keeps the last `limit` items. `undefined` limit keeps everything. */
export function windowItems<T>(all: ReadonlyArray<T>, limit?: number): Window<T> {
  if (limit === undefined || limit < 0 || all.length <= limit) {
    return { items: [...all], total: all.length, dropped: 0 };
  }
  return { items: all.slice(all.length - limit), total: all.length, dropped: all.length - limit };
}

/** One line naming what a window left out, so a cap is never silent. */
export function windowNote<T>(window: Window<T>, noun: string): string | null {
  if (window.dropped === 0) return null;
  return `(showing the last ${window.items.length} of ${window.total} ${noun}; ${window.dropped} older hidden — use --last N or --from/--to)`;
}

// ---------------------------------------------------------------------------
// Transcript

export interface TranscriptOptions {
  includeThinking?: boolean;
  /**
   * Emit one line per content event instead of joining a message's events.
   * Codex streams a token per event, so raw transcripts read as `[12702] v`.
   */
  raw?: boolean;
}

export function projectTranscript(
  events: ReadonlyArray<RawEvent>,
  opts: TranscriptOptions = {},
): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  // Identity of the line currently open for appending: same message, same kind
  // of block, uninterrupted. Any other emission closes it.
  let openKey: string | null = null;
  const key = (messageId: string | null, kind: string): string | null =>
    messageId === null ? null : `${kind}:${messageId}`;

  const push = (line: TranscriptLine, key: string | null): void => {
    if (!opts.raw && key !== null && key === openKey && lines.length > 0) {
      const last = lines[lines.length - 1];
      last.text += line.text;
      last.endSeq = line.seq;
      return;
    }
    lines.push(line);
    openKey = key;
  };

  for (const event of events) {
    if (event.type === 'input:sent') {
      const text = (event.data as InputSentData | undefined)?.text;
      if (text) push({ seq: event.seq, role: 'user', text }, null);
      continue;
    }
    if (event.type === 'content') {
      const messageId = messageIdOf(event);
      const blocks = asContentBlocks(event.data);
      for (const block of blocks) {
        if (block.type === 'text' && asString(block.text)) {
          push({ seq: event.seq, role: 'assistant', text: block.text! }, key(messageId, 'text'));
        } else if (opts.includeThinking && block.type === 'thinking' && asString(block.thinking)) {
          // The marker belongs to the line, not to every appended token.
          const thinkingKey = key(messageId, 'thinking');
          const open = !opts.raw && thinkingKey !== null && thinkingKey === openKey;
          push(
            {
              seq: event.seq,
              role: 'system',
              text: open ? block.thinking! : `[thinking] ${block.thinking!}`,
            },
            thinkingKey,
          );
        } else if (block.type === 'tool_use') {
          // A tool call between two text events means two separate paragraphs,
          // even when the provider gives them one message id. Joining them
          // would splice sentences together with no separator.
          openKey = null;
        }
      }
    }
  }
  return lines;
}

function seqRef(line: TranscriptLine): string {
  return line.endSeq !== undefined && line.endSeq !== line.seq
    ? `${line.seq}-${line.endSeq}`
    : `${line.seq}`;
}

export function renderTranscript(lines: ReadonlyArray<TranscriptLine>): string {
  if (lines.length === 0) return '(no transcript content)\n';
  return lines.map((line) => `[${seqRef(line)}] ${line.role}: ${line.text}`).join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// Inputs

export function projectInputs(events: ReadonlyArray<RawEvent>): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const event of events) {
    if (event.type !== 'input:sent') continue;
    const text = (event.data as InputSentData | undefined)?.text;
    if (text) lines.push({ seq: event.seq, role: 'user', text });
  }
  return lines;
}

export function renderInputs(lines: ReadonlyArray<TranscriptLine>): string {
  if (lines.length === 0) return '(no user input recorded)\n';
  return lines.map((line) => `[${line.seq}] ${line.text}`).join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// Tools

const TOOL_INPUT_KEYS_BY_PRIORITY = [
  'command',
  'file_path',
  'pattern',
  'description',
  'query',
  'url',
  'prompt',
];

function summarizeToolInput(input: Record<string, unknown> | undefined, max = 80): string {
  if (!input) return '';
  for (const key of TOOL_INPUT_KEYS_BY_PRIORITY) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) {
      return truncate(value.replace(/\s+/g, ' '), max);
    }
  }
  // Fallback: stringify a tiny digest of the input.
  return truncate(JSON.stringify(input).replace(/\s+/g, ' '), max);
}

export interface ToolsOptions {
  /** Case-insensitive substring: `bash` matches `Bash` and `BashOutput`. */
  nameFilter?: string;
}

export function toolNameMatches(name: string, filter: string): boolean {
  return name.toLowerCase().includes(filter.toLowerCase());
}

export function projectTools(
  events: ReadonlyArray<RawEvent>,
  opts: ToolsOptions = {},
): ToolCall[] {
  // Map tool_use_id -> result seq for cross-reference.
  const resultSeqByToolUseId = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'result') continue;
    const blocks = asContentBlocks(event.data);
    for (const block of blocks) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        resultSeqByToolUseId.set(block.tool_use_id, event.seq);
      }
    }
  }

  const calls: ToolCall[] = [];
  for (const event of events) {
    if (event.type !== 'content') continue;
    const blocks = asContentBlocks(event.data);
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue;
      const name = block.name ?? '(unknown)';
      if (opts.nameFilter && !toolNameMatches(name, opts.nameFilter)) continue;
      const toolUseId = block.id ?? null;
      calls.push({
        seq: event.seq,
        name,
        input: (block.input as Record<string, unknown>) ?? {},
        toolUseId,
        resultSeq: toolUseId ? resultSeqByToolUseId.get(toolUseId) ?? null : null,
      });
    }
  }
  return calls;
}

export function renderTools(calls: ReadonlyArray<ToolCall>): string {
  if (calls.length === 0) return '(no tool calls)\n';
  return (
    calls
      .map((call) => {
        const arrow = call.resultSeq !== null ? `${call.seq} -> ${call.resultSeq}` : `${call.seq}`;
        const summary = summarizeToolInput(call.input);
        return `[${arrow}] ${call.name}${summary ? '  ' + summary : ''}`;
      })
      .join('\n') + '\n'
  );
}

// ---------------------------------------------------------------------------
// Single event

export function renderEvent(event: RawEvent): string {
  const header = `seq=${event.seq} type=${event.type} timestamp=${new Date(
    event.timestamp,
  ).toISOString()}`;
  const payload = JSON.stringify(event.data, null, 2);
  return `${header}\n\n${payload}\n`;
}

// ---------------------------------------------------------------------------
// Show

export function projectUsage(events: ReadonlyArray<RawEvent>): UsageTotals {
  const totals: UsageTotals = {
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    turnCount: 0,
  };
  for (const event of events) {
    if (event.type !== 'turn:end') continue;
    const usage = (event.data as { usage?: Record<string, unknown> } | undefined)?.usage;
    if (!usage) continue;
    totals.turnCount += 1;
    totals.inputTokens += Number(usage.input_tokens ?? 0);
    totals.cacheCreationInputTokens += Number(usage.cache_creation_input_tokens ?? 0);
    totals.cacheReadInputTokens += Number(usage.cache_read_input_tokens ?? 0);
    totals.outputTokens += Number(usage.output_tokens ?? 0);
  }
  return totals;
}

export interface ShowOptions {
  metadata: SessionMetadata | null;
  summary: SessionSummaryRow | null;
  eventCount: number;
  eventTypeCounts: Record<string, number>;
  usage: UsageTotals;
  /** Current context size in tokens; null when the log has no measurement yet. */
  contextTokens?: number | null;
  /** running | idle | stopping | done, derived from the event log. */
  status?: string;
  categories?: SessionCategories | null;
}

export function renderShow(opts: ShowOptions): string {
  const lines: string[] = [];
  if (!opts.metadata) {
    return `(no metadata for this conversation)\n`;
  }
  const m = opts.metadata;
  lines.push(`conv:        ${m.conversationId}`);
  if (m.customName) lines.push(`name:        ${m.customName}`);
  if (opts.status) lines.push(`status:      ${opts.status}`);
  if (m.workspace) lines.push(`workspace:   ${m.workspace}`);
  if (m.workingDirectory) lines.push(`cwd:         ${m.workingDirectory}`);
  if (m.pickedUpFrom) lines.push(`picked up from: ${m.pickedUpFrom}`);
  if (m.latestProvider) lines.push(`provider:    ${m.latestProvider}`);
  if (m.model) lines.push(`model:       ${m.model}`);
  if (m.archived) lines.push(`archived:    yes`);
  if (m.createdAt) lines.push(`created:     ${m.createdAt}`);
  if (m.lastActivityAt) lines.push(`last active: ${m.lastActivityAt}`);
  lines.push(`events:      ${opts.eventCount}`);

  const u = opts.usage;
  if (u.turnCount > 0) {
    const totalIn = u.inputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens;
    lines.push(
      `usage:       ${u.turnCount} turns, in=${totalIn} (${u.cacheReadInputTokens} cached), out=${u.outputTokens}`,
    );
  }
  if (typeof opts.contextTokens === 'number') {
    lines.push(`context:     ${formatContextTokens(opts.contextTokens)} tokens now (server compacts at ${formatContextTokens(200_000)})`);
  }

  const cat = opts.categories;
  if (cat && (cat.primary || cat.theme)) {
    const secondary = cat.secondary.length > 0 ? ` (+${cat.secondary.join(', ')})` : '';
    const primary = cat.primary ?? cat.theme;
    lines.push(`category:    ${primary}${secondary}${cat.primary && cat.theme ? `  theme=${cat.theme}` : ''}`);
  }

  if (opts.summary) {
    const s = opts.summary;
    lines.push('');
    if (s.title) lines.push(`title:       ${s.title}`);
    if (s.project) lines.push(`project:     ${s.project}`);
    if (s.tags.length > 0) lines.push(`tags:        ${s.tags.join(', ')}`);
    if (s.summary) {
      lines.push('');
      lines.push('summary:');
      lines.push(s.summary);
    }
    if (s.notable) {
      lines.push('');
      lines.push('notable:');
      lines.push(s.notable);
    }
    if (s.filesTouched.length > 0) {
      lines.push('');
      lines.push(`files touched (${s.filesTouched.length}):`);
      // One per line: these are paths, and a comma-joined blob of 40 of them is
      // not greppable or clickable.
      for (const file of s.filesTouched) lines.push(`  ${file}`);
    }
    if (s.generatorModel || s.generatedAt) {
      lines.push('');
      lines.push(
        `summary written ${s.generatedAt ?? ''} by ${s.generatorModel ?? 'unknown'} (status=${s.status})`,
      );
    }
  } else if (opts.eventCount > 0) {
    lines.push('');
    lines.push('(no summary written for this session)');
  }

  if (m.initialPrompt) {
    lines.push('');
    lines.push('initial prompt:');
    lines.push(`  ${truncate(m.initialPrompt.replace(/\s+/g, ' '), 280)}`);
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// List

export interface ListRenderOptions {
  /** conversationId -> running | idle | stopping | done. */
  statuses?: ReadonlyMap<string, string>;
  /** Title plus a two-line summary per session instead of one dense row. */
  summaries?: boolean;
}

/** Local-time `YYYY-MM-DD HH:MM` for an ISO timestamp. */
function activityStamp(item: SessionListItem): string {
  const iso = item.lastActivityAt ?? item.updatedAt ?? item.createdAt;
  if (!iso) return ' '.repeat(16);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function listTitle(item: SessionListItem): string {
  return (
    item.summary?.title ||
    item.customName ||
    item.summary?.summary?.split('\n')[0]?.slice(0, 80) ||
    '(no summary)'
  );
}

/** Wrap to at most `maxLines` lines of `width`, ellipsizing the remainder. */
function wrapSummary(text: string, width: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ' ' + word;
    } else {
      out.push(current);
      current = word;
      if (out.length === maxLines) break;
    }
  }
  if (out.length < maxLines && current) out.push(current);
  if (out.length === maxLines) {
    const consumed = out.join(' ').length;
    if (consumed < text.replace(/\s+/g, ' ').trim().length) {
      out[maxLines - 1] = out[maxLines - 1] + ' …';
    }
  }
  return out;
}

export function renderList(
  items: ReadonlyArray<SessionListItem>,
  opts: ListRenderOptions = {},
): string {
  if (items.length === 0) return '(no sessions)\n';

  if (opts.summaries) {
    const blocks = items.map((item) => {
      const status = opts.statuses?.get(item.conversationId);
      const head = [
        activityStamp(item),
        status ? status.padEnd(8) : '',
        item.conversationId,
        item.summary?.project ? `[${item.summary.project}]` : '',
        listTitle(item),
        item.archived ? '(archived)' : '',
      ]
        .filter(Boolean)
        .join('  ');
      const body = item.summary?.summary
        ? wrapSummary(item.summary.summary, 94, 2).map((l) => `    ${l}`)
        : ['    (no summary written)'];
      return [head, ...body].join('\n');
    });
    return blocks.join('\n\n') + '\n';
  }

  const rows = items.map((item) => {
    const status = opts.statuses?.get(item.conversationId);
    const projTag = item.summary?.project ? `[${item.summary.project}]` : '';
    const archivedMarker = item.archived ? ' (archived)' : '';
    return (
      `${activityStamp(item)}  ` +
      (status ? `${status.padEnd(8)}  ` : '') +
      `${item.conversationId}  ` +
      `${item.eventCount.toString().padStart(6)} ev  ` +
      `${(item.model ?? '—').padEnd(16)}  ` +
      `${projTag} ${listTitle(item)}${archivedMarker}`
    ).trimEnd();
  });
  return rows.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Grep

export type GrepRole = 'user' | 'assistant' | 'thinking' | 'tool';

export const GREP_ROLES: GrepRole[] = ['user', 'assistant', 'thinking', 'tool'];

export interface GrepHit {
  seq: number;
  eventType: string;
  role: GrepRole;
  snippet: string;
}

export interface GrepOptions {
  /** Roles to search. Undefined searches all of them. */
  roles?: ReadonlyArray<GrepRole>;
}

function findSnippets(haystack: string, needle: string, around = 60): string[] {
  const lower = haystack.toLowerCase();
  const target = needle.toLowerCase();
  const out: string[] = [];
  let from = 0;
  while (from < lower.length) {
    const idx = lower.indexOf(target, from);
    if (idx < 0) break;
    const start = Math.max(0, idx - around);
    const end = Math.min(haystack.length, idx + target.length + around);
    let snippet = haystack.slice(start, end).replace(/\s+/g, ' ').trim();
    if (start > 0) snippet = '…' + snippet;
    if (end < haystack.length) snippet = snippet + '…';
    out.push(snippet);
    from = idx + target.length;
    if (out.length >= 3) break; // cap per event
  }
  return out;
}

/**
 * Searchable text split by role. Split rather than concatenated because a
 * session's tool results (file reads, Playwright dumps) can outweigh everything
 * the user and assistant said, and `--role` is how you get past them.
 */
function eventSearchableSegments(event: RawEvent): Array<{ role: GrepRole; text: string }> {
  if (event.type === 'input:sent') {
    const text = (event.data as InputSentData | undefined)?.text ?? '';
    return text ? [{ role: 'user', text }] : [];
  }
  if (event.type === 'content') {
    const out: Array<{ role: GrepRole; text: string }> = [];
    for (const block of asContentBlocks(event.data)) {
      if (block.type === 'text' && block.text) out.push({ role: 'assistant', text: block.text });
      if (block.type === 'thinking' && block.thinking) {
        out.push({ role: 'thinking', text: block.thinking });
      }
      if (block.type === 'tool_use') {
        const parts = [`[tool ${block.name ?? ''}]`];
        if (block.input) parts.push(JSON.stringify(block.input));
        out.push({ role: 'tool', text: parts.join(' ') });
      }
    }
    return out;
  }
  if (event.type === 'result') {
    const parts: string[] = [];
    for (const block of asContentBlocks(event.data)) {
      if (block.type === 'tool_result') {
        const content = block.content;
        if (typeof content === 'string') parts.push(content);
        else if (Array.isArray(content)) {
          for (const item of content as Array<{ type?: string; text?: string }>) {
            if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text);
          }
        }
      }
    }
    return parts.length > 0 ? [{ role: 'tool', text: parts.join(' ') }] : [];
  }
  return [];
}

export function projectGrep(
  events: ReadonlyArray<RawEvent>,
  query: string,
  opts: GrepOptions = {},
): GrepHit[] {
  if (!query) return [];
  const roles = opts.roles;
  const hits: GrepHit[] = [];
  for (const event of events) {
    for (const segment of eventSearchableSegments(event)) {
      if (roles && !roles.includes(segment.role)) continue;
      for (const snippet of findSnippets(segment.text, query)) {
        hits.push({ seq: event.seq, eventType: event.type, role: segment.role, snippet });
      }
    }
  }
  return hits;
}

export function renderGrep(
  hits: ReadonlyArray<GrepHit>,
  query: string,
  total = hits.length,
): string {
  if (total === 0) return `(no matches for ${JSON.stringify(query)})\n`;
  const body = hits.map((hit) => `[${hit.seq}] ${hit.role}: ${hit.snippet}`).join('\n');
  const header =
    hits.length < total
      ? `${total} matches for ${JSON.stringify(query)} (showing the last ${hits.length} — raise with --limit N)`
      : `${total} match${total === 1 ? '' : 'es'} for ${JSON.stringify(query)}`;
  return `${header}\n${body}\n`;
}
