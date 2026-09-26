import { parseJson } from '../../../utils/json.js';

/**
 * MCP tool results arrive wrapped in up to three layers of packaging before the
 * payload a person actually wants to read. This module peels the packaging,
 * works out what the inner payload *is*, and derives a one-line summary of it.
 *
 * Nothing here summarises destructively — `text` is always the complete inner
 * payload. Callers decide how much of it to show.
 */

export type ResultKind = 'json' | 'csv' | 'markdown' | 'text' | 'empty';

export interface UnwrappedResult {
  /** What the inner payload turned out to be. */
  kind: ResultKind;
  /** The complete inner payload as text. Never truncated. */
  text: string;
  /** Parsed form, when `kind === 'json'`. */
  json?: unknown;
  /** Packaging layers removed, outermost first. Empty when the result was already bare. */
  layers: string[];
  /** Size of the original result, in bytes. */
  rawBytes: number;
  /** Size of the inner payload, in bytes. */
  bytes: number;
  /** Call arguments recovered from a Codex envelope. Codex drops these from tool input. */
  args?: Record<string, unknown>;
  server?: string;
  tool?: string;
  /** True when the envelope reported a failure, regardless of the transport-level flag. */
  isError?: boolean;
}

/** Envelope keys that are transport bookkeeping, never content. */
const NOISE_KEYS = new Set([
  'request_id', 'requestId', 'appContext', 'pluginId', 'connectorId', '_meta',
  // Linear returns the ProseMirror document as a base64 blob alongside the plain text.
  'descriptionState', 'documentContent', 'progressHistory', 'sortOrder',
]);

/**
 * Content stubs some connectors return alongside the real payload. When `content[]`
 * says only this and `structuredContent` is present, the structured side is the payload.
 */
const STUB_CONTENT = /^(action completed\.?|ok\.?|success\.?|done\.?)$/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function joinTextBlocks(blocks: unknown[]): string {
  return blocks
    .filter((b): b is Record<string, unknown> => isRecord(b))
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Remove transport bookkeeping from the top level of an object. */
export function stripNoise(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!NOISE_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Peel packaging until we reach a payload. Handles, in any combination:
 *   Codex `{type:'mcpToolCall', result:{...}}` envelope
 *   MCP `{content:[{type:'text',text}], structuredContent}` wrapper
 *   bare `[{type:'text',text}]` content arrays
 *   a JSON string that itself contains one of the above
 */
export function unwrapResult(raw: string): UnwrappedResult {
  const rawBytes = raw.length;
  const layers: string[] = [];
  let args: Record<string, unknown> | undefined;
  let server: string | undefined;
  let tool: string | undefined;
  let isError: boolean | undefined;

  let current = raw;

  for (let depth = 0; depth < 5; depth++) {
    // Lenient: a truncated envelope should still give up its inner payload.
    const parsed = tryJson(current);
    if (parsed === undefined) break;

    // Codex app-server envelope. The arguments live here and nowhere else —
    // the adapter passes `{}` as the tool input, so this is the only copy.
    if (isRecord(parsed) && (parsed.type === 'mcpToolCall' || parsed.type === 'dynamicToolCall')) {
      layers.push('codex envelope');
      if (isRecord(parsed.arguments)) args = parsed.arguments;
      if (typeof parsed.server === 'string') server = parsed.server;
      if (typeof parsed.tool === 'string') tool = parsed.tool;
      if (parsed.status === 'failed' || parsed.success === false || parsed.error) isError = true;

      const inner = parsed.result ?? parsed.contentItems ?? parsed.error;
      if (inner === undefined || inner === null) {
        current = '';
        break;
      }
      current = typeof inner === 'string' ? inner : JSON.stringify(inner);
      continue;
    }

    // MCP result wrapper. Prefer structuredContent when content[] is only a stub —
    // Gmail and GitHub connectors put the entire payload in structuredContent and
    // leave content[] saying "Action completed."
    if (isRecord(parsed) && (Array.isArray(parsed.content) || parsed.structuredContent !== undefined)) {
      const blocks = Array.isArray(parsed.content) ? joinTextBlocks(parsed.content) : '';
      const structured = parsed.structuredContent;
      const blocksAreStub = !blocks.trim() || STUB_CONTENT.test(blocks.trim());

      if (structured !== undefined && structured !== null && blocksAreStub) {
        layers.push('mcp structuredContent');
        current = typeof structured === 'string' ? structured : JSON.stringify(structured);
        continue;
      }
      if (blocks) {
        layers.push('mcp content[]');
        current = blocks;
        continue;
      }
    }

    // Hosted connectors (claude.ai Slack, Notion) wrap a prose payload in one JSON field:
    // `{"messages": "...", "pagination_info": "..."}`. The long string is the payload.
    const textField = isRecord(parsed) ? connectorTextField(parsed) : null;
    if (textField) {
      layers.push(`connector ${textField.key}`);
      current = textField.text;
      continue;
    }

    // Bare content array.
    if (Array.isArray(parsed) && parsed.some((b) => isRecord(b) && typeof b.text === 'string')) {
      layers.push('content[]');
      current = joinTextBlocks(parsed);
      continue;
    }

    break;
  }

  const text = current;
  return { kind: detectKind(text), text, json: tryJson(text), layers, rawBytes, bytes: text.length, args, server, tool, isError };
}

/** Below this a string field is a label beside the payload, not the payload. */
const SIDE_FIELD_CHARS = 200;

/**
 * The one long string in an object whose other fields are short scalars. Objects with
 * nested values are records, not wrapped prose, and stay as they are.
 */
function connectorTextField(obj: Record<string, unknown>): { key: string; text: string } | null {
  const entries = Object.entries(obj).filter(([k]) => !NOISE_KEYS.has(k));
  const scalar = (v: unknown): boolean =>
    v === null || ['string', 'number', 'boolean'].includes(typeof v) || (Array.isArray(v) && v.length === 0);
  if (!entries.length || !entries.every(([, v]) => scalar(v))) return null;
  const long = entries.filter(([, v]) => typeof v === 'string' && (v.length > SIDE_FIELD_CHARS || v.includes('\n\n')));
  if (long.length !== 1) return null;
  const [key, text] = long[0] as [string, string];
  return { key, text };
}

function tryJson(text: string): unknown {
  const t = text.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return undefined;
  try {
    return parseJson(t);
  } catch {
    return undefined;
  }
}

/** Count commas that sit outside double quotes — quoted message bodies are full of them. */
function unquotedCommas(line: string): number {
  let inQuotes = false;
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ',' && !inQuotes) n++;
  }
  return n;
}

export function detectKind(text: string): ResultKind {
  const t = text.trim();
  if (!t) return 'empty';
  if (tryJson(t) !== undefined) return 'json';

  const lines = t.split('\n');
  // A CSV header: several unquoted separators, and a second line that agrees.
  if (lines.length >= 2) {
    const sep = unquotedCommas(lines[0]) >= 3 ? ',' : lines[0].split('\t').length - 1 >= 2 ? '\t' : null;
    if (sep) {
      const head = sep === ',' ? unquotedCommas(lines[0]) : lines[0].split('\t').length - 1;
      const next = sep === ',' ? unquotedCommas(lines[1]) : lines[1].split('\t').length - 1;
      // Header must not look like prose, and row 1 must have a comparable field count.
      if (!/[.!?]\s/.test(lines[0]) && Math.abs(head - next) <= Math.max(2, head * 0.3)) return 'csv';
    }
  }

  if (/^#{1,6}\s|^[-*]\s+\S|^\d+\.\s+\S|^>\s|^\|.*\|$|```/m.test(t)) return 'markdown';
  return 'text';
}

// ── CSV ──

/** RFC4180-ish parser. Handles quoted fields containing separators and newlines. */
export function parseDelimited(text: string, sep: string = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0]?.trim());
}

// ── Column ordering ──

/** Headers that name an identifier or a link rather than content. */
const ID_HEADER = /(^|_)(id|ids|ts|uid|guid|uuid|cursor|permalink|url|link|href|hash|sha|token)$/i;

/** A value that is machine-facing: long runs of digits/hex, or a URL. */
function looksMachine(v: string): boolean {
  const s = v.trim();
  if (!s) return false;
  if (/^https?:\/\//.test(s)) return true;
  if (/^[0-9]+(\.[0-9]+)?$/.test(s) && s.replace('.', '').length >= 10) return true;
  if (/^[0-9a-f]{16,}$/i.test(s)) return true;
  if (/^[A-Z0-9]{9,}$/.test(s)) return true;
  return false;
}

/**
 * Order columns so the ones carrying content come first. A Slack CSV leads with
 * five ID columns and puts the message text ninth — read in source order, the
 * table shows everything except what was said.
 */
export function rankColumns(header: string[], rows: string[][]): number[] {
  const sample = rows.slice(0, 40);
  const scored = header.map((h, i) => {
    // A column with no value in any row says nothing, so it is left out entirely.
    const filledAnywhere = rows.some((r) => (r[i] ?? '').trim());
    const values = sample.map((r) => r[i] ?? '').filter(Boolean);
    const fill = sample.length ? values.length / sample.length : 0;
    const machineRatio = values.length ? values.filter(looksMachine).length / values.length : 0;
    const avgLen = values.length ? values.reduce((a, v) => a + v.length, 0) / values.length : 0;
    // Content columns: prose-length values that don't look machine-generated, weighted
    // by how many rows actually have one so a mostly-empty column does not lead.
    let score = (Math.min(avgLen, 120) / 120) * fill;
    if (ID_HEADER.test(h)) score -= 1.5;
    score -= machineRatio;
    if (/^(title|name|subject|identifier)$/i.test(h)) score += 2 * fill;
    else if (/^(text|body|message|content|summary|description)$/i.test(h)) score += 1.5 * fill;
    return { i, score, filledAnywhere };
  });
  return scored
    .filter((s) => s.filledAnywhere)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((s) => s.i);
}

// ── Summary ──

/** Keys whose array value is the substance of a result, most specific first. */
const COLLECTION_KEYS = [
  'issues', 'results', 'messages', 'meetings', 'events', 'teams', 'projects',
  'files', 'items', 'responses', 'buttons', 'rows', 'records', 'data', 'nodes',
];

/** Keys that identify an individual item, in preference order. */
const LABEL_KEYS = ['identifier', 'name', 'title', 'subject', 'id', 'key', 'path', 'url', 'text'];

function labelOf(item: unknown): string | null {
  if (typeof item === 'string') return item;
  if (!isRecord(item)) return null;
  for (const k of LABEL_KEYS) {
    const v = item[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

/**
 * Peel single-key wrappers. `{"issue": {...}}` and `{"data": {"results": [...]}}` carry
 * nothing at the outer level — the substance is one level down.
 */
export function descendSingleKey(json: unknown): unknown {
  let cur = json;
  for (let i = 0; i < 3; i++) {
    if (!isRecord(cur)) break;
    const keys = Object.keys(cur).filter((k) => !NOISE_KEYS.has(k));
    if (keys.length !== 1) break;
    const inner = cur[keys[0]];
    if (!isRecord(inner) && !Array.isArray(inner)) break;
    cur = inner;
  }
  return cur;
}

/** Find the collection that carries the substance, descending one level if needed. */
export function findCollection(json: unknown): { key: string; items: unknown[] } | null {
  if (Array.isArray(json)) return { key: 'items', items: json };
  if (!isRecord(json)) return null;

  for (const k of COLLECTION_KEYS) {
    const v = json[k];
    if (Array.isArray(v)) return { key: k, items: v };
    // Linear-style `{issues: {nodes: [...]}}`
    if (isRecord(v) && Array.isArray(v.nodes)) return { key: k, items: v.nodes };
  }
  // Any array-valued key, if it's the only substantial one.
  const arrays = Object.entries(json).filter(([, v]) => Array.isArray(v) && (v as unknown[]).length > 0);
  if (arrays.length === 1) return { key: arrays[0][0], items: arrays[0][1] as unknown[] };
  return null;
}

/**
 * A one-line description of what came back — the counterpart to the input summary
 * these cards already show. Returns null when nothing better than the raw text exists.
 */
export function summariseResult(u: UnwrappedResult): string | null {
  if (u.kind === 'empty') return 'no content';

  if (u.kind === 'csv') {
    const rows = parseDelimited(u.text);
    if (rows.length >= 2) return `${(rows.length - 1).toLocaleString()} rows × ${rows[0].length} columns`;
    return null;
  }

  if (u.kind === 'json' && u.json !== undefined) {
    const core = descendSingleKey(u.json);

    // A bare list: count it and name the first few members.
    if (Array.isArray(core)) {
      const labels = core.slice(0, 3).map(labelOf).filter(Boolean) as string[];
      const head = `${core.length.toLocaleString()} items`;
      if (!labels.length) return head;
      const shown = labels.map((l) => (l.length > 40 ? l.slice(0, 39) + '…' : l)).join(', ');
      return core.length > labels.length ? `${head}: ${shown}, …` : `${head}: ${shown}`;
    }

    const shape = describeShape(u.json);
    if (shape) return shape;

    const single = labelOf(core);
    if (single) return single.length > 80 ? single.slice(0, 79) + '…' : single;
    return null;
  }

  const firstLine = u.text.split('\n').find((l) => l.trim());
  if (!firstLine) return null;
  const clean = firstLine.replace(/^#{1,6}\s*/, '').trim();
  return clean.length > 100 ? clean.slice(0, 99) + '…' : clean;
}

// ── Shape ──

export type FieldKind = 'scalar' | 'scalars' | 'records' | 'prose' | 'object';

export interface Field {
  key: string;
  kind: FieldKind;
  /** Rendered value for scalars. */
  value?: string;
  /** Element count for arrays. */
  count?: number;
  /** The raw value, for blocks that need their own renderer. */
  raw?: unknown;
  /** Characters, for prose. */
  chars?: number;
  /** Machine bookkeeping — kept, but shown behind a toggle rather than up front. */
  plumbing?: boolean;
}

/** Above this a string gets its own block instead of sitting inline with the scalars. */
const PROSE_CHARS = 120;

/**
 * Describe every top-level field without dropping any. The previous approach picked
 * the largest array and rendered only that — for a result like
 * `{text, dialogs, buttons[]}` it showed the buttons and silently lost the rest.
 */
/** Keys that exist for machines: identifiers, timestamps, colours, cursors. */
const PLUMBING_KEY = /(^|_)(id|ids|uid|guid|uuid|hash|sha|token|cursor|color|colour|createdat|updatedat|created_at|updated_at|timestamp|ts|_ts|version|etag|mime|raw_mime)$/i;

/** True when the value carries no meaning to a reader on its own. */
function isPlumbingValue(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) || /^#[0-9a-f]{6}$/i.test(s) || /^\d{4}-\d{2}-\d{2}T/.test(s);
}

export function describeFields(json: unknown): Field[] {
  const core = descendSingleKey(json);
  if (!isRecord(core)) return [];

  const fields: Field[] = [];
  for (const [key, v] of Object.entries(core)) {
    if (NOISE_KEYS.has(key)) continue;

    if (Array.isArray(v)) {
      if (v.every((x) => !isRecord(x) && !Array.isArray(x))) {
        fields.push({ key, kind: 'scalars', count: v.length, value: v.map(String).join(', '), raw: v, plumbing: PLUMBING_KEY.test(key) });
      } else {
        fields.push({ key, kind: 'records', count: v.length, raw: v });
      }
      continue;
    }
    if (isRecord(v)) {
      // A nested object with a human label is a scalar in disguise: `state: {name: "Triage"}`.
      const label = labelOf(v);
      const meaningful = Object.entries(v).filter(([k, val]) => !PLUMBING_KEY.test(k) && val !== null && val !== '');
      if (label && meaningful.length <= 2) {
        fields.push({ key, kind: 'scalar', value: label });
      } else {
        fields.push({ key, kind: 'object', count: Object.keys(v).length, raw: v });
      }
      continue;
    }
    const s = v === null || v === undefined ? '' : String(v);
    if (s.length > PROSE_CHARS) fields.push({ key, kind: 'prose', chars: s.length, value: s, raw: s });
    else fields.push({ key, kind: 'scalar', value: s, plumbing: PLUMBING_KEY.test(key) || isPlumbingValue(s) });
  }
  return fields;
}

/** Fields that describe status rather than identity — worth promoting into the headline. */
const FACET_KEYS = /^(state|status|type|kind|priority|severity|assignee|team|project|owner|author|from_?|sender|channel|label|stage|result|success|count|total)$/i;

/**
 * A sentence about what came back: what it is, how much of it, and the few values
 * that distinguish this call from another one of the same tool.
 */
export function describeShape(json: unknown): string | null {
  const fields = describeFields(json);
  if (!fields.length) return null;

  const core = descendSingleKey(json);
  const rec = isRecord(core) ? core : {};

  // Identity first, when the payload is a single named thing.
  const ident = typeof rec.identifier === 'string' ? rec.identifier : typeof rec.key === 'string' ? rec.key : null;
  const title = typeof rec.title === 'string' ? rec.title
    : typeof rec.subject === 'string' ? rec.subject
    : typeof rec.name === 'string' ? rec.name : null;

  const parts: string[] = [];
  for (const f of fields) {
    if (f.key === 'identifier' || f.key === 'key' || f.key === 'title' || f.key === 'subject' || f.key === 'name') continue;
    if (f.plumbing) continue;
    if (f.kind === 'records' || f.kind === 'scalars') parts.push(`${f.count?.toLocaleString()} ${f.key}`);
    else if (f.kind === 'prose') parts.push(`${f.key} ${f.chars?.toLocaleString()} chars`);
    // A bare number as a facet ("priority 0") says less than nothing — only take words.
    else if (f.kind === 'scalar' && f.value && FACET_KEYS.test(f.key) && !/^\d+(\.\d+)?$/.test(f.value)) {
      parts.push(f.value);
    }
  }

  const head = [ident, title].filter(Boolean).join(' ');
  const tail = parts.slice(0, 5).join(' · ');
  const joined = head && tail ? `${head} · ${tail}` : head || tail;
  if (!joined) return null;
  return joined.length > 140 ? joined.slice(0, 139) + '…' : joined;
}

// ── Records ──

/** A scalar rendering of a cell value. Nested structures collapse to a compact hint. */
function flatten(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return '';
    if (v.every((x) => typeof x === 'string' || typeof x === 'number')) return v.join(', ');
    return `${v.length} items`;
  }
  if (isRecord(v)) {
    const label = labelOf(v);
    return label ?? `{${Object.keys(v).length} fields}`;
  }
  return String(v);
}

/**
 * A list of same-shaped objects is a table, not a JSON document. Returns the union
 * of keys as a header plus one row per record, or null when the value isn't list-shaped.
 */
export function toRecords(json: unknown): { header: string[]; body: string[][]; key: string } | null {
  const found = findCollection(descendSingleKey(json));
  if (!found || found.items.length < 2) return null;

  const records = found.items.filter(isRecord);
  if (records.length < found.items.length || records.length < 2) return null;

  const keys: string[] = [];
  for (const r of records) {
    for (const k of Object.keys(r)) {
      if (!NOISE_KEYS.has(k) && !keys.includes(k)) keys.push(k);
    }
  }
  if (!keys.length || keys.length > 40) return null;

  return { header: keys, body: records.map((r) => keys.map((k) => flatten(r[k]))), key: found.key };
}
