import React, { useMemo, useState } from 'react';
import { cn } from '../../../utils/cn.js';
import { tk } from '../../../tokens.js';
import { BRANDS, actionName } from './brand.js';
import { BrandCard, ShowMore, Avatar } from './BrandCard.js';
import { unwrapResult, parseDelimited } from './unwrapResult.js';
import { parseSlackText } from './slackText.js';
import { MarkdownView, McpResultBody } from './McpResultBody.js';

/**
 * Slack results arrive as CSV, with Slack's own mrkdwn inside the Text column.
 *
 * Slack returns no colours or avatar URLs, so the brand comes from the mark, the
 * aubergine accent, and reproducing Slack's own message layout — avatar, bold display
 * name, timestamp, then the message with mrkdwn rendered rather than shown as source.
 */

interface SlackCardProps {
  toolName: string;
  input: Record<string, unknown>;
  result: string;
  isError?: boolean;
}

interface Message {
  id: string;
  user: string;
  realName: string;
  channel: string;
  text: string;
  time: string;
  permalink?: string;
  reactions?: string;
  threadTs?: string;
  botName?: string;
  fileCount?: number;
  /** Time already formatted by the source, used when `time` is not a parseable date. */
  timeText?: string;
  files?: string;
  bot?: boolean;
  isReply?: boolean;
}

// ── Slack mrkdwn ──

/**
 * Slack's mrkdwn is not markdown: bold is *single* asterisks, italic is _underscores_,
 * links are <url|label>, mentions are <@U123> and channels are <#C123|name>.
 */
function renderMrkdwn(raw: string): React.ReactNode[] {
  // Slack escapes &, < and > in message text; private-use glyphs are its own icon font.
  const text = raw.replace(/[\uE000-\uF8FF]/g, '');
  const plain = (t: string): string => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const parts: React.ReactNode[] = [];
  const re = /(<[@#!][^>]+>|<[^>|]+\|[^>]+>|<https?:\/\/[^>]+>|```[\s\S]+?```|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|:[a-z0-9_+-]+:)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;

  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(plain(text.slice(last, m.index)));
    const t = m[0];
    k++;

    if (t.startsWith('<@')) {
      parts.push(
        <span key={k} className="rounded px-1 text-[inherit]" style={{ backgroundColor: '#1D9BD11A', color: '#1D9BD1' }}>
          @{t.slice(2, -1).split('|')[1] ?? t.slice(2, -1)}
        </span>,
      );
    } else if (t.startsWith('<#')) {
      const label = t.slice(2, -1).split('|')[1];
      parts.push(
        <span key={k} style={{ color: '#1D9BD1' }}>
          #{label ?? t.slice(2, -1)}
        </span>,
      );
    } else if (t.startsWith('<') && t.includes('|')) {
      const [href, label] = t.slice(1, -1).split('|');
      parts.push(
        <a key={k} href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#1D9BD1' }} className="no-underline hover:underline">
          {label}
        </a>,
      );
    } else if (t.startsWith('<http')) {
      const href = t.slice(1, -1);
      parts.push(
        <a key={k} href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#1D9BD1' }} className="no-underline hover:underline">
          {href.length > 60 ? href.slice(0, 59) + '…' : href}
        </a>,
      );
    } else if (t.startsWith('```')) {
      parts.push(
        <code key={k} className={cn('block my-1 px-2 py-1 rounded whitespace-pre-wrap font-mono text-[12px]', tk.codeBgSubtle, tk.text.primary)}>
          {t.slice(3, -3).trim()}
        </code>,
      );
    } else if (t.startsWith('`')) {
      parts.push(
        <code key={k} className={cn('px-1 py-0.5 rounded font-mono text-[12px]', tk.codeBgSubtle, tk.text.primary)}>
          {t.slice(1, -1)}
        </code>,
      );
    } else if (t.startsWith('*')) {
      parts.push(<strong key={k} className={tk.text.heading}>{t.slice(1, -1)}</strong>);
    } else if (t.startsWith('_')) {
      parts.push(<em key={k}>{t.slice(1, -1)}</em>);
    } else if (t.startsWith('~')) {
      parts.push(<s key={k} className={tk.text.faint}>{t.slice(1, -1)}</s>);
    } else if (t.startsWith(':')) {
      parts.push(
        <span key={k} className={cn('text-[11px]', tk.text.faint)} title={t}>
          {t}
        </span>,
      );
    }
    last = m.index + t.length;
  }
  if (last < text.length) parts.push(plain(text.slice(last)));
  return parts;
}

// ── Parsing ──

/** A bare Slack channel ID carries no meaning to a reader. */
const RAW_ID = /^[CDG][A-Z0-9]{6,}$/;

/**
 * `C0BPTKEAE4C (#inc-2026-08-12-…)` → the readable half. When the CSV gives only an
 * ID, the channel the call asked for is the better label — that's where the name is.
 */
function channelLabel(raw: string, fallback?: string): string {
  const m = raw.match(/\(#([^)]+)\)/);
  if (m) return `#${m[1]}`;
  if (RAW_ID.test(raw)) return fallback ? channelLabel(fallback) : '';
  if (!raw) return fallback ? channelLabel(fallback) : '';
  if (raw === 'DM' || raw.startsWith('DM ')) return raw;
  return raw.startsWith('#') || raw.startsWith('@') ? raw : `#${raw}`;
}

/** Slack's own format: "Apr 8 1:13 PM". */
function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return (
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  );
}

/** The channel named in the call arguments, when there is one. */
function channelFromArgs(input: Record<string, unknown>, recovered?: Record<string, unknown>): string | undefined {
  const a = Object.keys(input).length ? input : (recovered ?? {});
  for (const k of ['channel_id', 'filter_in_channel', 'channel']) {
    const v = a[k];
    if (typeof v === 'string' && v && !RAW_ID.test(v)) return v;
  }
  return undefined;
}

function parseMessages(csv: string): Message[] | null {
  const rows = parseDelimited(csv, ',');
  if (rows.length < 2) return null;
  const header = rows[0].map((h) => h.trim());
  const idx = (name: string): number => header.indexOf(name);
  if (idx('Text') === -1 || idx('Time') === -1) return null;

  const col = (r: string[], name: string): string => {
    const i = idx(name);
    return i >= 0 ? (r[i] ?? '') : '';
  };

  return rows.slice(1)
    .filter((r) => r.length > 1)
    .map((r) => ({
      id: col(r, 'MsgID'),
      user: col(r, 'UserName'),
      realName: col(r, 'RealName') || col(r, 'UserName') || col(r, 'BotName'),
      channel: col(r, 'Channel'),
      text: col(r, 'Text'),
      time: col(r, 'Time'),
      permalink: col(r, 'Permalink') || undefined,
      reactions: col(r, 'Reactions') || undefined,
      threadTs: col(r, 'ThreadTs') || undefined,
      botName: col(r, 'BotName') || undefined,
      fileCount: Number(col(r, 'FileCount')) || 0,
    }));
}

// ── Rendering ──

const PREVIEW = 6;
/** Slack messages are the content, so this is generous — it only catches essays. */
const TEXT_CHARS = 1200;

function MessageRow({
  m,
  showChannel,
  channelName,
}: {
  m: Message;
  showChannel: boolean;
  channelName?: string;
}): React.JSX.Element {
  const [showAll, setShowAll] = useState(m.text.length <= TEXT_CHARS);
  const shown = showAll ? m.text : m.text.slice(0, TEXT_CHARS) + '…';
  const name = m.realName || m.botName || m.user || 'unknown';
  const when = m.timeText ?? (m.time ? timeLabel(m.time) : '');
  const reactions = m.reactions?.replace(/[()]/g, '');
  const files = m.files ?? ((m.fileCount ?? 0) > 0 ? `${m.fileCount} file${m.fileCount === 1 ? '' : 's'}` : undefined);

  return (
    <div className="flex gap-2 px-3 py-2 min-w-0">
      <Avatar name={name} size={22} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className={cn('text-[13px] font-semibold', tk.text.heading)}>{name}</span>
          {(m.botName || m.bot) && <span className={cn('text-[11px]', tk.text.faint)}>app</span>}
          {when && <span className={cn('text-[11px]', tk.text.faint)}>{when}</span>}
          {showChannel && (m.channel || channelName) && (
            <span className={cn('text-[11px]', tk.text.muted)}>{channelLabel(m.channel, channelName)}</span>
          )}
          {m.threadTs && m.threadTs !== m.id && (
            <span className={cn('text-[10px]', tk.text.faint)}>in thread</span>
          )}
          {m.permalink && (
            <a
              href={m.permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] no-underline hover:underline"
              style={{ color: '#1D9BD1' }}
            >
              open
            </a>
          )}
        </div>
        <div className={cn('text-[13px] leading-relaxed break-words whitespace-pre-wrap', tk.text.primary)}>
          {renderMrkdwn(shown)}
        </div>
        {!showAll && (
          <button onClick={() => setShowAll(true)} className={cn('text-[11px] mt-0.5', tk.text.faint)}>
            show {(m.text.length - TEXT_CHARS).toLocaleString()} more characters
          </button>
        )}
        {(reactions || files) && (
          <div className={cn('mt-0.5 flex flex-wrap gap-3 text-[11px]', tk.text.faint)}>
            {files && <span>{files}</span>}
            {reactions && <span>{reactions}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Senders' tools: the result is only a link, so the card shows what was sent. */
const SEND_ACTION = /(send_message|schedule_message|add_message)/;

function argsOf(input: Record<string, unknown>, recovered?: Record<string, unknown>): string {
  const a = Object.keys(input).length ? input : (recovered ?? {});
  const parts: string[] = [];
  const query = a.search_query ?? a.query ?? (Array.isArray(a.keywords) ? a.keywords.join(' ') : a.keywords);
  if (typeof query === 'string' && query) parts.push(query);
  for (const k of ['filters', 'channel', 'channel_id', 'filter_in_channel', 'user_id', 'file_id', 'filter_date_on']) {
    const v = a[k];
    // A bare Slack ID means nothing to a reader; the result usually names it instead.
    if (typeof v === 'string' && v && !/^[CDGUFW][A-Z0-9]{6,}$/.test(v)) parts.push(v);
  }
  return parts.join('  ');
}

function SentMessage({ input, unwrapped }: { input: Record<string, unknown>; unwrapped: ReturnType<typeof unwrapResult> }): React.JSX.Element {
  const text = [input.message, input.text, input.payload].find((v): v is string => typeof v === 'string') ?? '';
  const json = unwrapped.json as Record<string, unknown> | undefined;
  const link = typeof json?.message_link === 'string' ? json.message_link : undefined;
  const markdown = typeof input.content_type === 'string' && input.content_type.includes('markdown');
  return (
    <div className="px-3 py-2 min-w-0">
      {markdown ? (
        <MarkdownView text={text} />
      ) : (
        <div className={cn('text-[13px] leading-relaxed break-words whitespace-pre-wrap', tk.text.primary)}>
          {renderMrkdwn(text)}
        </div>
      )}
      {link && (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-block text-[11px] no-underline hover:underline"
          style={{ color: '#1D9BD1' }}
        >
          open in Slack
        </a>
      )}
    </div>
  );
}

function MessageList({ messages, channelName }: { messages: Message[]; channelName?: string }): React.JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const channels = new Set(messages.map((m) => channelLabel(m.channel, channelName)).filter(Boolean));
  const shown = showAll ? messages : messages.slice(0, PREVIEW);
  const replies = messages.filter((m) => m.isReply).length;
  const firstReply = shown.findIndex((m) => m.isReply);

  return (
    <>
      <div className={cn('divide-y', tk.separator)}>
        {shown.map((m, i) => (
          <React.Fragment key={m.id || i}>
            {i === firstReply && i > 0 && (
              <div className={cn('px-3 py-1 text-[11px]', tk.text.faint)}>
                {replies} {replies === 1 ? 'reply' : 'replies'}
              </div>
            )}
            <MessageRow m={m} showChannel={channels.size > 1} channelName={channelName} />
          </React.Fragment>
        ))}
      </div>
      {!showAll && messages.length > PREVIEW && (
        <ShowMore hidden={messages.length - PREVIEW} unit="messages" onClick={() => setShowAll(true)} />
      )}
    </>
  );
}

function summarise(messages: Message[], channelName?: string): string {
  const channels = [...new Set(messages.map((m) => channelLabel(m.channel, channelName)).filter(Boolean))];
  const people = [...new Set(messages.map((m) => m.realName || m.botName).filter(Boolean))];
  return [
    `${messages.length} message${messages.length === 1 ? '' : 's'}`,
    channels.length === 1 ? `in ${channels[0]}` : channels.length > 1 ? `in ${channels.length} channels` : '',
    people.length && people.length <= 3 ? `from ${people.join(', ')}` : people.length ? `from ${people.length} people` : '',
  ].filter(Boolean).join(' ');
}

export function SlackCard({ toolName, input, result }: SlackCardProps): React.JSX.Element {
  const unwrapped = useMemo(() => unwrapResult(result ?? ''), [result]);
  const csvMessages = useMemo(() => parseMessages(unwrapped.text), [unwrapped.text]);
  const hosted = useMemo(() => (csvMessages ? null : parseSlackText(unwrapped.text)), [csvMessages, unwrapped.text]);

  const brand = BRANDS.slack;
  const action = actionName(toolName);
  const args = argsOf(input, unwrapped.args);
  const channelName = channelFromArgs(input, unwrapped.args) ?? hosted?.channel;

  if (SEND_ACTION.test(toolName)) {
    return (
      <BrandCard brand={brand} action={action} args={channelLabel('', channelName) || args}>
        <SentMessage input={input} unwrapped={unwrapped} />
      </BrandCard>
    );
  }

  const messages: Message[] | null = csvMessages ?? hosted?.messages.map((m, i) => ({
    id: String(i),
    user: m.name,
    realName: m.name,
    channel: m.channel ?? '',
    text: m.text,
    time: '',
    timeText: m.time,
    permalink: m.permalink,
    reactions: m.reactions,
    files: m.files,
    bot: m.bot,
    isReply: m.isReply,
  })) ?? null;

  // A header row with no data rows, or the connector's own sentence, is a search that matched nothing.
  const empty = !messages && (/^MsgID,/.test(unwrapped.text.trim()) || /^No results found\.?$/m.test(unwrapped.text));
  if (empty) {
    return (
      <BrandCard brand={brand} action={action} args={args} summary="no messages matched">
        <div className={cn('px-3 py-2 text-[12px]', tk.text.faint)}>
          The search returned no messages{channelName ? ` in ${channelLabel('', channelName)}` : ''}.
        </div>
      </BrandCard>
    );
  }

  if (!messages) {
    // Profiles, member lists, uploads and errors come back as prose; show it as prose.
    const plainError = unwrapped.text.length < 300 && /not found|invalid|error|exceeds/i.test(unwrapped.text);
    return (
      <BrandCard brand={brand} action={action} args={args}>
        {plainError ? (
          <div className="px-3 py-2 text-[12px] text-red-600 dark:text-red-400/80">{unwrapped.text.trim()}</div>
        ) : unwrapped.kind === 'csv' || unwrapped.kind === 'json' ? (
          <McpResultBody result={result} />
        ) : (
          <div className="px-3 py-2">
            <MarkdownView text={unwrapped.text.trim() || 'No content returned.'} />
          </div>
        )}
      </BrandCard>
    );
  }

  return (
    <BrandCard brand={brand} action={action} args={args} summary={summarise(messages, channelName)}>
      <MessageList messages={messages} channelName={channelName} />
    </BrandCard>
  );
}
