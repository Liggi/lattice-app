import React, { useMemo, useState } from 'react';
import { diffWords } from 'diff';
import { parseJson } from '../../../utils/json.js';
import { FileText, Database, Users, Hash } from 'lucide-react';
import { cn } from '../../../utils/cn.js';
import { tk } from '../../../tokens.js';
import { BRANDS, actionName, notionColor } from './brand.js';
import { BrandCard, ShowMore } from './BrandCard.js';
import { unwrapResult } from './unwrapResult.js';
import { MarkdownView, McpResultBody } from './McpResultBody.js';

/**
 * Notion cards.
 *
 * Notion returns its colours as palette *names* (`blue`, `orange`, `default`) rather
 * than hex, so they go through a lookup; page icons arrive as real unicode emoji and
 * render directly. `rich_text` carries Notion's own annotation model — bold, italic,
 * code, colour — which is rendered rather than flattened to a string.
 */

interface NotionCardProps {
  toolName: string;
  input: Record<string, unknown>;
  result: string;
  isError?: boolean;
}

interface SearchHit {
  id: string;
  title: string;
  url?: string;
  type?: string;
  highlight?: string;
  timestamp?: string;
  emoji?: string;
}

interface RichText {
  plain_text?: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
    color?: string;
  };
}

type Parsed =
  | { kind: 'search'; hits: SearchHit[] }
  | { kind: 'page'; title: string; url?: string; text: string; emoji?: string }
  | { kind: 'block'; blockType: string; rich: RichText[]; inTrash?: boolean }
  | { kind: 'error'; code: string; status?: number; message: string }
  | null;

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function emojiOf(v: unknown): string | undefined {
  const r = rec(v);
  if (!r) return undefined;
  return str(r.emoji) ?? (str(r.type) === 'emoji' ? str(r.emoji) : undefined);
}

function parseNotion(json: unknown, rawText: string): Parsed {
  const r = rec(json);

  if (r) {
    // API error envelope
    if (str(r.name) === 'APIResponseError' || str(r.code)) {
      let message = str(r.message) ?? '';
      const body = str(r.body);
      if (!message && body) {
        try { message = str((parseJson(body) as Record<string, unknown>).message) ?? body; } catch { message = body; }
      }
      return {
        kind: 'error',
        code: str(r.code) ?? 'error',
        status: typeof r.status === 'number' ? r.status : undefined,
        message: message || 'Request failed',
      };
    }

    // notion-search
    if (Array.isArray(r.results)) {
      const hits = (r.results as unknown[])
        .map((h) => {
          const hr = rec(h);
          if (!hr) return null;
          const title = str(hr.title)
            ?? str(rec(rec(hr.properties)?.title)?.plain_text)
            ?? str(hr.id);
          if (!title) return null;
          return {
            id: str(hr.id) ?? title,
            title,
            url: str(hr.url),
            type: str(hr.type) ?? str(hr.object),
            highlight: str(hr.highlight),
            timestamp: str(hr.timestamp) ?? str(hr.last_edited_time),
            emoji: emojiOf(hr.icon),
          } as SearchHit;
        })
        .filter(Boolean) as SearchHit[];
      // An empty results array is "nothing matched", not an unparseable payload.
      return { kind: 'search', hits };
    }

    // notion-fetch: {metadata:{type}, title, url, text}
    const title = str(r.title);
    const text = str(r.text);
    if (title && text) {
      return { kind: 'page', title, url: str(r.url), text, emoji: emojiOf(r.icon) };
    }

    // A block object, e.g. from delete-a-block / update-a-block
    const blockType = str(r.type);
    if (str(r.object) === 'block' && blockType) {
      const payload = rec(r[blockType]);
      const rich = Array.isArray(payload?.rich_text) ? (payload!.rich_text as RichText[]) : [];
      return { kind: 'block', blockType, rich, inTrash: r.in_trash === true };
    }
  }

  // A page fetch whose JSON never closed. Notion pages are large and get cut — by
  // Claude Code's size limit, or by anything else upstream — so recover the fields
  // by hand rather than dropping to a dump.
  if (!r && /^\s*\{"metadata"\s*:\s*\{\s*"type"\s*:\s*"page"/.test(rawText)) {
    const title = rawText.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
    const url = rawText.match(/"url"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
    const textStart = rawText.indexOf('"text":"');
    if (title && textStart !== -1) {
      const body = rawText
        .slice(textStart + 8)
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
      return { kind: 'page', title: title.replace(/\\"/g, '"'), url, text: body };
    }
  }

  // Claude Code's oversize-result stub — the payload never reaches the renderer.
  if (/exceeds maximum allowed tokens|Output too large/i.test(rawText)) {
    const path = rawText.match(/(\/[^\s]+\.(?:txt|json))/)?.[1];
    return {
      kind: 'error',
      code: 'result too large',
      message: path ? `Full output written to ${path}` : 'Result exceeded the size limit and was written to disk',
    };
  }

  return null;
}

// ── Rendering ──

const TYPE_ICON: Record<string, React.ElementType> = {
  page: FileText,
  database: Database,
  data_source: Database,
  user: Users,
};

function RichTextView({ rich }: { rich: RichText[] }): React.JSX.Element {
  return (
    <span>
      {rich.map((t, i) => {
        const a = t.annotations ?? {};
        const color = notionColor(a.color);
        const style: React.CSSProperties = {};
        if (color && a.color !== 'default') style.color = color;
        if (a.color?.endsWith('_background') && color) {
          style.backgroundColor = `${color}26`;
          style.color = undefined;
        }

        let node: React.ReactNode = t.plain_text ?? '';
        if (a.code) {
          node = (
            <code className={cn('px-1 py-0.5 rounded text-[12px]', tk.codeBgSubtle)} style={{ color: '#EB5757' }}>
              {node}
            </code>
          );
        }
        if (a.bold) node = <strong className={tk.text.heading}>{node}</strong>;
        if (a.italic) node = <em>{node}</em>;
        if (a.strikethrough) node = <s>{node}</s>;
        if (a.underline) node = <u>{node}</u>;
        if (t.href) {
          node = (
            <a href={t.href} target="_blank" rel="noopener noreferrer" className="no-underline hover:underline" style={{ color: '#337EA9' }}>
              {node}
            </a>
          );
        }
        return (
          <span key={i} style={style}>
            {node}
          </span>
        );
      })}
    </span>
  );
}

function HitRow({ h }: { h: SearchHit }): React.JSX.Element {
  const Icon = TYPE_ICON[h.type ?? 'page'] ?? Hash;
  const when = h.timestamp?.slice(0, 10);

  return (
    <div className="px-3 py-2 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        {h.emoji ? (
          <span className="text-[14px] flex-shrink-0 leading-none">{h.emoji}</span>
        ) : (
          <Icon size={13} className={cn('flex-shrink-0', tk.text.faint)} />
        )}
        <span className={cn('text-[13px] truncate min-w-0 flex-1', tk.text.heading)}>{h.title}</span>
        {when && <span className={cn('text-[11px] flex-shrink-0 tabular-nums', tk.text.faint)}>{when}</span>}
        {h.url && (
          <a
            href={h.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] no-underline hover:underline flex-shrink-0"
            style={{ color: '#337EA9' }}
          >
            open
          </a>
        )}
      </div>
      {h.highlight && (
        <div className={cn('text-[12px] leading-relaxed mt-0.5 pl-[21px] line-clamp-2', tk.text.muted)}>
          …{h.highlight}…
        </div>
      )}
    </div>
  );
}

/**
 * notion-fetch wraps the page in an XML-ish envelope: an ancestor path, a properties
 * blob repeating the title, and comment anchors wrapped around the prose. Strip the
 * scaffolding, keep the words — including the text inside the comment anchors.
 */
function stripPageEnvelope(text: string): string {
  return text
    .replace(/^Here is the result of[^\n]*\n/, '')
    .replace(/<ancestor-path>[\s\S]*?<\/ancestor-path>/g, '')
    .replace(/<properties>[\s\S]*?<\/properties>/g, '')
    // Comment anchors: drop the tags, keep what they wrap.
    .replace(/<span\s+discussion-urls="[^"]*"\s*>/g, '')
    .replace(/<\/span>/g, '')
    .replace(/<\/?(?:page|parent-page|ancestor-\d+-page|database|content)\b[^>]*>/g, '')
    .replace(/<iconMetadata>[\s\S]*?<\/iconMetadata>/g, '')
    // Toggles: the summary becomes a bold line, the body follows it.
    .replace(/<summary>([\s\S]*?)<\/summary>/g, '**$1**')
    .replace(/<\/?details>/g, '')
    .replace(/<image\b[^>]*>(?:<\/image>)?/g, '[image]')
    // Uploaded images arrive as signed URLs that expire in minutes; name them instead.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt ? `[image: ${alt}]` : '[image]'))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const PREVIEW = 6;

function argsOf(input: Record<string, unknown>, recovered?: Record<string, unknown>): string {
  const a = Object.keys(input).length ? input : (recovered ?? {});
  for (const k of ['query', 'search', 'page_id', 'block_id', 'url', 'data_source_id']) {
    const v = a[k];
    // A page or block UUID means nothing to a reader; the result names the page instead.
    if (typeof v === 'string' && v && !/^[0-9a-f]{8}-?[0-9a-f]{4}-?/i.test(v)) return v;
  }
  return '';
}

const PAGE_CHARS = 1200;

function PageBody({ text }: { text: string }): React.JSX.Element {
  const [showAll, setShowAll] = useState(text.length <= PAGE_CHARS);
  return (
    <>
      <MarkdownView text={showAll ? text : text.slice(0, PAGE_CHARS)} />
      {!showAll && <ShowMore hidden={text.length - PAGE_CHARS} unit="characters" onClick={() => setShowAll(true)} />}
    </>
  );
}

interface PageEditInput {
  summary: string;
  replacements: Array<{ old: string; next: string }>;
  content?: string;
  properties?: Record<string, unknown>;
}

/** What an update asked Notion to change, read from the call: the result is only an ID. */
function editOf(input: Record<string, unknown>): PageEditInput | null {
  const command = str(input.command);
  const updates = Array.isArray(input.content_updates) ? input.content_updates.map(rec).filter(Boolean) as Record<string, unknown>[] : [];
  const replacements = updates
    .map((u) => ({ old: str(u.old_str) ?? '', next: str(u.new_str) ?? '' }))
    .filter((u) => u.old || u.next);
  const content = str(input.new_str) ?? str(input.content);
  const properties = rec(input.properties) ?? undefined;
  if (!command && !replacements.length && !content && !properties) return null;

  const n = replacements.length;
  const summary = n ? `edited ${n} passage${n === 1 ? '' : 's'}`
    : command === 'replace_content' ? 'replaced the page'
    : command === 'update_properties' || properties ? 'updated properties'
    : content ? 'added content'
    : (command ?? 'updated').replace(/_/g, ' ');
  return { summary, replacements, content, properties };
}

/** Markup (tables, images, toggles) diffs as noise; it reads better rendered, before and after. */
const MARKUP = /<\/?(?:table|tr|td|image|details|summary|callout|columns?)\b/;

function Replacement({ old, next }: { old: string; next: string }): React.JSX.Element {
  const markup = MARKUP.test(old) || MARKUP.test(next);
  if (markup) {
    return (
      <div>
        {[['Before', old], ['After', next]].map(([label, text]) => (
          <div key={label} className="pt-2">
            <div className={cn('px-3 text-[11px]', tk.text.faint)}>{label}</div>
            <MarkdownView text={stripPageEnvelope(text) || '(nothing)'} />
          </div>
        ))}
      </div>
    );
  }
  return <WordDiff old={old} next={next} />;
}

/** Word-level before and after, so a one-word change in a long paragraph is findable. */
function WordDiff({ old, next }: { old: string; next: string }): React.JSX.Element {
  const parts = useMemo(() => diffWords(old, next), [old, next]);
  return (
    <div className={cn('px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap break-words', tk.text.primary)}>
      {parts.map((p, i) => (
        <span
          key={i}
          className={cn(
            p.removed && 'line-through text-red-700 dark:text-red-300/80 bg-red-500/10',
            p.added && 'text-emerald-800 dark:text-emerald-300 bg-emerald-500/15',
          )}
        >
          {p.value}
        </span>
      ))}
    </div>
  );
}

function PageEdit({ edit }: { edit: PageEditInput }): React.JSX.Element {
  return (
    <div className={cn('divide-y', tk.separator)}>
      {edit.replacements.map((r, i) => <Replacement key={i} old={r.old} next={r.next} />)}
      {edit.content && <PageBody text={stripPageEnvelope(edit.content)} />}
      {edit.properties && (
        <div className="px-3 py-2 space-y-0.5">
          {Object.entries(edit.properties).map(([k, v]) => (
            <div key={k} className="text-[12px]">
              <span className={tk.text.faint}>{k} </span>
              <span className={tk.text.primary}>{typeof v === 'string' ? v : JSON.stringify(v)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function NotionCard({ toolName, input, result, isError }: NotionCardProps): React.JSX.Element {
  const unwrapped = useMemo(() => unwrapResult(result ?? ''), [result]);
  const parsed = useMemo(() => parseNotion(unwrapped.json, unwrapped.text), [unwrapped.json, unwrapped.text]);
  const [showAll, setShowAll] = useState(false);

  const brand = BRANDS.notion;
  const action = actionName(toolName);
  const args = argsOf(input, unwrapped.args);

  const edit = editOf(input);
  if (edit && !parsed) {
    return (
      <BrandCard brand={brand} action={action} args={args} summary={edit.summary}>
        <PageEdit edit={edit} />
      </BrandCard>
    );
  }

  if (!parsed) {
    // Page markdown and other prose read as a page; records fall to the field view.
    const prose = unwrapped.kind === 'markdown' || unwrapped.kind === 'text';
    return (
      <BrandCard brand={brand} action={action} args={args}>
        {prose ? <PageBody text={stripPageEnvelope(unwrapped.text)} /> : <McpResultBody result={result} />}
      </BrandCard>
    );
  }

  if (parsed.kind === 'error') {
    return (
      <BrandCard brand={brand} action={action} args={args} summary={parsed.code}>
        <div className="px-3 py-2">
          <div className="text-[12px] text-red-600 dark:text-red-400/80">
            {parsed.status ? `${parsed.status} · ` : ''}
            {parsed.code}
          </div>
          <div className={cn('text-[12px] mt-1 break-words', tk.text.secondary)}>{parsed.message}</div>
        </div>
      </BrandCard>
    );
  }

  if (parsed.kind === 'search') {
    const shown = showAll ? parsed.hits : parsed.hits.slice(0, PREVIEW);
    return (
      <BrandCard
        brand={brand}
        action={action}
        args={args}
        summary={parsed.hits.length ? `${parsed.hits.length} result${parsed.hits.length === 1 ? '' : 's'}` : 'no results'}
       
      >
        {parsed.hits.length === 0 && (
          <div className={cn('px-3 py-2 text-[12px]', tk.text.faint)}>No pages matched.</div>
        )}
        <div className={cn('divide-y', tk.separator)}>
          {shown.map((h) => <HitRow key={h.id} h={h} />)}
        </div>
        {!showAll && parsed.hits.length > PREVIEW && (
          <ShowMore hidden={parsed.hits.length - PREVIEW} unit="results" onClick={() => setShowAll(true)} />
        )}
      </BrandCard>
    );
  }

  if (parsed.kind === 'block') {
    return (
      <BrandCard
        brand={brand}
        action={action}
        args={args}
        summary={`${parsed.blockType}${parsed.inTrash ? ' · deleted' : ''}`}
      >
        <div className={cn('px-3 py-2 text-[13px] leading-relaxed', tk.text.primary)}>
          {parsed.rich.length ? <RichTextView rich={parsed.rich} /> : <span className={tk.text.faint}>(empty block)</span>}
        </div>
      </BrandCard>
    );
  }

  // A fetched page.
  const showEmoji = parsed.emoji && !parsed.title.startsWith(parsed.emoji);
  return (
    <BrandCard brand={brand} action={action} args={args} summary={parsed.title}>
      <div className="px-3 pt-2 pb-1 flex items-center gap-2">
        {showEmoji && <span className="text-[15px] leading-none">{parsed.emoji}</span>}
        <span className={cn('text-[14px] font-medium min-w-0 flex-1', tk.text.heading)}>{parsed.title}</span>
        {parsed.url && (
          <a
            href={parsed.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] no-underline hover:underline flex-shrink-0"
            style={{ color: '#337EA9' }}
          >
            open in Notion
          </a>
        )}
      </div>
      <PageBody text={stripPageEnvelope(parsed.text)} />
    </BrandCard>
  );
}
