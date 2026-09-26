import React, { useState, useMemo } from 'react';
import { Chrome, Globe, MousePointer, Monitor, Terminal, Network, Image, CheckCircle2, Activity, FileSearch, TreePine } from 'lucide-react';
import { CollapsibleToolCard } from '../CollapsibleToolCard.js';
import { cn } from '../../utils/cn.js';
import { tk, accent } from '../../tokens.js';
import { unwrapContentBlocks, imageBlockToDataUrl } from '../../utils/content-blocks.js';

interface ChromeDevToolsToolProps {
  toolName: string;
  input: Record<string, unknown>;
  result: string;
}

// ── Parsed result types ──

interface ParsedPage { id: string; label: string; selected: boolean }
interface ParsedConsoleMsg { id: string; level: string; text: string }
interface ParsedNetworkReq { id: string; method: string; url: string; status: string }

type ParsedResult =
  | { kind: 'confirmation'; text: string }
  | { kind: 'script'; preamble: string | null; code: string }
  | { kind: 'image'; dataUrl: string; text?: string }
  | { kind: 'pages'; pages: ParsedPage[]; header?: string }
  | { kind: 'console'; messages: ParsedConsoleMsg[]; header?: string }
  | { kind: 'network'; requests: ParsedNetworkReq[]; header?: string }
  | { kind: 'snapshot'; text: string }
  | { kind: 'prose'; text: string }
  | { kind: 'raw'; text: string };

// ── Text parsers for Chrome DevTools markdown format ──

/** Parse "## Pages\n1: about:blank [selected]\n2: http://example.com" */
function parsePages(text: string): ParsedPage[] | null {
  if (!text.includes('## Pages')) return null;
  const lines = text.split('\n');
  const pages: ParsedPage[] = [];
  for (const line of lines) {
    // Format: "1: http://localhost:3005/chat [selected]" or "1: about:blank"
    const match = line.match(/^\s*(\d+):\s+(.+?)(\s+\[selected\])?\s*$/);
    if (match) {
      pages.push({ id: match[1], label: match[2], selected: !!match[3] });
    }
  }
  return pages.length > 0 ? pages : null;
}

/** Parse "## Console messages\nShowing 1-4 of 4...\nmsgid=6 [error] text (0 args)" */
function parseConsoleMessages(text: string): ParsedConsoleMsg[] | null {
  if (!text.includes('## Console messages')) return null;
  const lines = text.split('\n');
  const messages: ParsedConsoleMsg[] = [];
  for (const line of lines) {
    // Format: "msgid=6 [error] Failed to load resource... (0 args)"
    const match = line.match(/^msgid=(\d+)\s+\[(\w+)]\s+(.+)$/);
    if (match) {
      messages.push({ id: match[1], level: match[2], text: match[3] });
    }
  }
  return messages.length > 0 ? messages : null;
}

/** Parse "## Network requests\nShowing 1-113...\nreqid=352 GET url [200]" */
function parseNetworkRequests(text: string): ParsedNetworkReq[] | null {
  if (!text.includes('## Network requests')) return null;
  const lines = text.split('\n');
  const requests: ParsedNetworkReq[] = [];
  for (const line of lines) {
    // Format: "reqid=352 GET http://localhost:3001/c/conv-CTMXTGlt47DA [200]"
    const match = line.match(/^reqid=(\d+)\s+(\w+)\s+(\S+)\s+\[(\d+)]/);
    if (match) {
      requests.push({ id: match[1], method: match[2], url: match[3], status: match[4] });
    }
  }
  return requests.length > 0 ? requests : null;
}

/** Extract "Showing X-Y of Z" header line */
function extractShowingHeader(text: string): string | undefined {
  const match = text.match(/Showing \d+-\d+ of \d+.*$/m);
  return match?.[0];
}

// ── Action classification ──

/**
 * The bare action, whatever the call was named: Claude uses
 * `mcp__chrome-devtools__evaluate_script` (or `chrome_isolated` for the second
 * browser instance), Codex uses `MCP:chrome-devtools.evaluate`. Every renderer
 * and icon below switches on this, so a missed scheme means a raw JSON dump.
 */
function getAction(toolName: string): string {
  const claude = toolName.match(/^mcp__chrome[_-](?:devtools|isolated)__(.+)$/i);
  const codex = toolName.match(/^MCP:chrome[_-](?:devtools|isolated)\.(.+)$/i);
  return claude?.[1] ?? codex?.[1] ?? toolName;
}

const CONFIRMATION_ACTIONS = new Set([
  'click', 'fill', 'type_text', 'press_key', 'hover', 'drag',
  'navigate_page', 'close_page', 'select_page', 'new_page',
  'handle_dialog', 'upload_file', 'resize_page', 'emulate',
  'fill_form',
]);

function parseResult(action: string, raw: string): ParsedResult {
  if (!raw || !raw.trim()) return { kind: 'confirmation', text: 'Completed' };

  // Step 1: Unwrap MCP content block wrappers
  const unwrapped = unwrapContentBlocks(raw);
  const text = unwrapped ? unwrapped.text : raw;

  // Screenshot: check for image content block
  if (action === 'take_screenshot' && unwrapped) {
    const imageBlock = unwrapped.blocks.find(b => b.type === 'image' && b.source?.data);
    const dataUrl = imageBlock ? imageBlockToDataUrl(imageBlock) : null;
    if (dataUrl) {
      return { kind: 'image', dataUrl, text: text || undefined };
    }
  }

  // Confirmations — use first meaningful line only
  if (CONFIRMATION_ACTIONS.has(action)) {
    const firstLine = text.split('\n').find(l => l.trim() && !l.startsWith('##')) || text.split('\n')[0];
    return { kind: 'confirmation', text: firstLine.trim() };
  }

  // evaluate_script: "Script ran on page and returned:\n```json\n...\n```"
  if (action === 'evaluate_script') {
    const fenceMatch = text.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      const preamble = text.slice(0, text.indexOf('```')).trim() || null;
      let code = fenceMatch[1];
      try { code = JSON.stringify(JSON.parse(code), null, 2); } catch { /* keep raw */ }
      return { kind: 'script', preamble, code };
    }
    return { kind: 'script', preamble: null, code: text };
  }

  // list_pages / pages in results
  if (action === 'list_pages' || text.includes('## Pages')) {
    const pages = parsePages(text);
    if (pages) return { kind: 'pages', pages };
  }

  // list_console_messages
  if (action === 'list_console_messages' || text.includes('## Console messages')) {
    const messages = parseConsoleMessages(text);
    if (messages) return { kind: 'console', messages, header: extractShowingHeader(text) };
  }

  // list_network_requests
  if (action === 'list_network_requests' || text.includes('## Network requests')) {
    const requests = parseNetworkRequests(text);
    if (requests) return { kind: 'network', requests, header: extractShowingHeader(text) };
  }

  // take_snapshot / wait_for with snapshot
  if (action === 'take_snapshot' || (action === 'wait_for' && text.includes('## Latest page snapshot'))) {
    return { kind: 'snapshot', text };
  }

  // Performance and lighthouse — markdown prose
  if (action.includes('performance') || action === 'lighthouse_audit') {
    return { kind: 'prose', text };
  }

  return { kind: 'raw', text };
}

// ── Action → icon ──

function getActionIcon(action: string): React.ElementType {
  if (action === 'take_screenshot') return Image;
  if (action === 'take_snapshot') return TreePine;
  if (action.includes('page') || action.includes('navigate')) return Globe;
  if (action.includes('click') || action.includes('fill') || action.includes('hover') || action.includes('drag') || action.includes('type') || action.includes('press')) return MousePointer;
  if (action.includes('console')) return Terminal;
  if (action.includes('network')) return Network;
  if (action.includes('script') || action.includes('evaluate')) return Terminal;
  if (action.includes('performance') || action.includes('lighthouse')) return Activity;
  if (action.includes('emulate') || action.includes('resize')) return Monitor;
  if (action.includes('wait')) return FileSearch;
  return Chrome;
}

function getInputSummary(action: string, input: Record<string, unknown>): string {
  if (input.url && typeof input.url === 'string') {
    try { return new URL(input.url).hostname + new URL(input.url).pathname.slice(0, 40); }
    catch { return (input.url as string).slice(0, 60); }
  }
  if (input.selector && typeof input.selector === 'string') return input.selector as string;
  if (input.text && typeof input.text === 'string') return (input.text as string).slice(0, 60);
  if (input.expression && typeof input.expression === 'string') return (input.expression as string).slice(0, 60);
  if (input.value && typeof input.value === 'string') return (input.value as string).slice(0, 60);
  if (input.uid && typeof input.uid === 'string') return `uid: ${input.uid}`;
  const fn = input.function;
  if (typeof fn === 'string') return fn.slice(0, 60);
  for (const val of Object.values(input)) {
    if (typeof val === 'string' && val.length > 0) return val.slice(0, 60);
  }
  return '';
}

// ── Sub-renderers ──

function PagesView({ pages }: { pages: ParsedPage[] }): React.JSX.Element {
  return (
    <div className={`divide-y ${tk.separator} max-h-64 overflow-y-auto ${tk.scrollbar}`}>
      {pages.map((page) => (
        <div key={page.id} className="px-3 py-1.5 flex items-center gap-2">
          <Globe size={10} className={page.selected ? accent.cyan.icon : tk.text.faint} />
          <span className={cn('text-[13px] font-mono flex-shrink-0', tk.text.faint)}>{page.id}</span>
          <span className={cn('text-[13px] truncate flex-1 min-w-0', tk.text.primary)}>{page.label}</span>
          {page.selected && (
            <span className="text-[11px] px-1 py-0.5 rounded bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 flex-shrink-0">
              selected
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

const CONSOLE_LEVEL_STYLES: Record<string, string> = {
  error: 'bg-red-500/15 dark:bg-red-500/10 text-red-700 dark:text-red-400/80',
  warn: 'bg-amber-500/15 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400/80',
  warning: 'bg-amber-500/15 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400/80',
  issue: 'bg-amber-500/15 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400/80',
  info: 'bg-parchment-200/60 dark:bg-stone-800/50 text-parchment-600 dark:text-stone-400',
  debug: 'bg-parchment-200/60 dark:bg-stone-800/50 text-parchment-500 dark:text-stone-500',
};
const CONSOLE_DEFAULT_STYLE = 'bg-parchment-200/40 dark:bg-stone-800/30 text-parchment-600 dark:text-stone-400';

function ConsoleView({ messages, header }: { messages: ParsedConsoleMsg[]; header?: string }): React.JSX.Element {
  return (
    <div className="max-h-72 overflow-y-auto">
      {header && (
        <div className={cn('px-3 py-1 text-[13px]', tk.text.faint)}>{header}</div>
      )}
      <div className={`divide-y ${tk.separator}`}>
        {messages.map((msg) => (
          <div key={msg.id} className="px-3 py-1.5 flex gap-2 items-start">
            <span className={cn(
              'text-[9px] px-1 py-0.5 rounded flex-shrink-0 font-mono',
              CONSOLE_LEVEL_STYLES[msg.level] || CONSOLE_DEFAULT_STYLE,
            )}>
              {msg.level}
            </span>
            <span className={cn('text-[13px] leading-relaxed font-mono break-all flex-1 min-w-0', tk.text.primary)}>
              {msg.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const METHOD_STYLES: Record<string, string> = {
  GET: 'text-emerald-700 dark:text-emerald-400/80',
  POST: 'text-parchment-700 dark:text-stone-300',
  PUT: 'text-amber-700 dark:text-amber-400/80',
  PATCH: 'text-amber-700 dark:text-amber-400/80',
  DELETE: 'text-red-700 dark:text-red-400/80',
};

function statusColor(status: string): string {
  const code = parseInt(status, 10);
  if (code >= 200 && code < 300) return 'text-emerald-700 dark:text-emerald-400/80';
  if (code >= 300 && code < 400) return tk.text.secondary;
  if (code >= 400 && code < 500) return 'text-amber-700 dark:text-amber-400/80';
  if (code >= 500) return 'text-red-700 dark:text-red-400/80';
  return tk.text.muted;
}

function truncateUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    return path.length > 60 ? path.slice(0, 57) + '...' : path;
  } catch {
    return url.length > 60 ? url.slice(0, 57) + '...' : url;
  }
}

function NetworkView({ requests, header }: { requests: ParsedNetworkReq[]; header?: string }): React.JSX.Element {
  return (
    <div className="max-h-72 overflow-y-auto">
      {header && (
        <div className={cn('px-3 py-1 text-[13px]', tk.text.faint)}>{header}</div>
      )}
      <div className={`divide-y ${tk.separator}`}>
        {requests.map((req) => (
          <div key={req.id} className="px-3 py-1.5 flex items-center gap-2">
            <span className={cn('text-[13px] font-mono font-medium w-8 flex-shrink-0', METHOD_STYLES[req.method] || tk.text.muted)}>
              {req.method}
            </span>
            <span className={cn('text-[13px] font-mono w-7 flex-shrink-0 text-right', statusColor(req.status))}>
              {req.status}
            </span>
            <span className={cn('text-[13px] font-mono truncate flex-1 min-w-0', tk.text.primary)}>
              {truncateUrl(req.url)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConfirmationView({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="px-3 py-2 flex items-start gap-2">
      <CheckCircle2 size={12} className="text-emerald-600 dark:text-emerald-400/80 flex-shrink-0 mt-0.5" />
      <span className={cn('text-[13px] leading-relaxed whitespace-pre-wrap', tk.text.secondary)}>{text}</span>
    </div>
  );
}

function ScriptResultView({ preamble, code }: { preamble: string | null; code: string }): React.JSX.Element {
  return (
    <div>
      {preamble && (
        <div className={cn('px-3 pt-2 pb-1 text-[13px]', tk.text.secondary)}>{preamble}</div>
      )}
      <pre className={cn(
        'm-0 px-3 py-2.5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words max-h-64 overflow-auto',
        tk.codeBg, tk.text.primary, tk.scrollbar,
      )}>
        {code}
      </pre>
    </div>
  );
}

function ImageView({ dataUrl, text }: { dataUrl: string; text?: string }): React.JSX.Element {
  return (
    <div className="px-3 py-2">
      {text && <span className={cn('text-[13px] block mb-2', tk.text.secondary)}>{text}</span>}
      <img
        src={dataUrl}
        alt="Screenshot"
        className="rounded border border-parchment-200 dark:border-stone-800/40 max-w-full max-h-80 object-contain"
      />
    </div>
  );
}

function SnapshotView({ text }: { text: string }): React.JSX.Element {
  // Show first N lines of the accessibility tree with indentation preserved
  const lines = text.split('\n');
  const treeStart = lines.findIndex(l => l.trim().startsWith('uid='));
  const preamble = treeStart > 0 ? lines.slice(0, treeStart).filter(l => l.trim()).join('\n') : null;
  const treeLines = treeStart >= 0 ? lines.slice(treeStart) : lines;
  const truncated = treeLines.length > 40;
  const display = treeLines.slice(0, 40).join('\n');

  return (
    <div>
      {preamble && (
        <div className={cn('px-3 pt-2 pb-1 text-[13px]', tk.text.secondary)}>{preamble}</div>
      )}
      <pre className={cn(
        'm-0 px-3 py-2.5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words max-h-72 overflow-auto',
        tk.codeBg, tk.text.primary, tk.scrollbar,
      )}>
        {display}
      </pre>
      {truncated && (
        <div className={cn('px-3 py-1 text-[13px] text-center', tk.text.faint)}>
          {treeLines.length - 40} more lines...
        </div>
      )}
    </div>
  );
}

function ProseView({ text }: { text: string }): React.JSX.Element {
  return (
    <pre className={cn(
      'm-0 px-3 py-2.5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words max-h-72 overflow-auto',
      tk.codeBg, tk.text.primary, tk.scrollbar,
    )}>
      {text}
    </pre>
  );
}

function RawView({ text }: { text: string }): React.JSX.Element {
  let display = text;
  try { display = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ }
  return (
    <pre className={cn(
      'm-0 px-3 py-2.5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words max-h-64 overflow-auto',
      tk.codeBg, tk.text.primary, tk.scrollbar,
    )}>
      {display}
    </pre>
  );
}

// ── Main component ──

export function ChromeDevToolsTool({ toolName, input, result }: ChromeDevToolsToolProps): React.JSX.Element {
  const action = getAction(toolName);
  const parsed = useMemo(() => parseResult(action, result), [action, result]);

  const itemCount = parsed.kind === 'pages' ? parsed.pages.length
    : parsed.kind === 'console' ? parsed.messages.length
    : parsed.kind === 'network' ? parsed.requests.length
    : 0;

  const [isExpanded, setIsExpanded] = useState(() => {
    if (parsed.kind === 'confirmation') return true;
    if (parsed.kind === 'image') return true;
    if (parsed.kind === 'script') return true;
    if (itemCount > 0 && itemCount <= 8) return true;
    return false;
  });

  const ActionIcon = getActionIcon(action);
  const summary = getInputSummary(action, input);
  const label = action.replace(/_/g, ' ');
  const countBadge = itemCount > 0 ? `${itemCount}` : undefined;

  // Confirmation cards that fit in one line don't need expand/collapse
  const isCompactConfirmation = parsed.kind === 'confirmation' && !parsed.text.includes('\n');

  return (
    <CollapsibleToolCard
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      canExpand={!isCompactConfirmation}
      cardClassName={accent.cyan.card}
      headerContent={(
        <>
          <div className="flex items-center gap-2 flex-shrink-0">
            <ActionIcon size={14} className={`${accent.cyan.icon} flex-shrink-0`} />
            <span className={`text-xs ${tk.text.muted}`}>{label}</span>
          </div>
          <span className={`text-xs ${tk.text.secondary} truncate flex-1`}>{summary}</span>
          {countBadge && (
            <span className={`text-[13px] ${tk.text.faint} flex-shrink-0`}>{countBadge}</span>
          )}
          {isCompactConfirmation && (
            <CheckCircle2 size={12} className="text-emerald-600 dark:text-emerald-400/80 flex-shrink-0" />
          )}
        </>
      )}
      content={(
        <div className={`border-t ${tk.separator}`}>
          {parsed.kind === 'confirmation' && <ConfirmationView text={parsed.text} />}
          {parsed.kind === 'script' && <ScriptResultView preamble={parsed.preamble} code={parsed.code} />}
          {parsed.kind === 'image' && <ImageView dataUrl={parsed.dataUrl} text={parsed.text} />}
          {parsed.kind === 'pages' && <PagesView pages={parsed.pages} />}
          {parsed.kind === 'console' && <ConsoleView messages={parsed.messages} header={parsed.header} />}
          {parsed.kind === 'network' && <NetworkView requests={parsed.requests} header={parsed.header} />}
          {parsed.kind === 'snapshot' && <SnapshotView text={parsed.text} />}
          {parsed.kind === 'prose' && <ProseView text={parsed.text} />}
          {parsed.kind === 'raw' && <RawView text={parsed.text} />}
        </div>
      )}
    />
  );
}
