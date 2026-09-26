import React, { useState } from 'react';
import { AlertTriangle, Edit, ExternalLink, FileEdit, FileText, Globe, Plug, Search, Terminal, Wrench } from 'lucide-react';
import { CollapsibleToolCard } from './CollapsibleToolCard.js';
import { brandFor, actionName } from './tools/mcp/brand.js';
import { isMcpTool, isChromeDevToolsTool, mcpToolLabel } from './tools/mcp/index.js';
import { formatFilePath } from '../utils/tool-utils.js';
import { parseJson } from '../utils/json.js';
import { cn } from '../utils/cn.js';
import { tk } from '../tokens.js';

/**
 * A failed tool call keeps the look of the tool that failed — its icon or brand mark
 * and what it was doing — and shows the error's own message rather than the envelope
 * it arrived in (MCP error codes, API error JSON, <tool_use_error> tags).
 */

const MESSAGE_KEYS = ['message', 'error_description', 'detail', 'error', 'body', 'errors'];

function messageFromJson(value: unknown, depth = 0): string | null {
  if (depth > 4 || value == null) return null;
  if (typeof value === 'string') {
    const t = value.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { return messageFromJson(parseJson(t), depth + 1) ?? t; } catch { return t; }
    }
    return t || null;
  }
  if (Array.isArray(value)) {
    const parts = value.map((v) => messageFromJson(v, depth + 1)).filter((v): v is string => !!v);
    return parts.length ? parts.join('\n') : null;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of MESSAGE_KEYS) {
      const m = messageFromJson(obj[key], depth + 1);
      if (m) return m;
    }
  }
  return null;
}

/** The error's own words, with transport wrapping removed. Falls back to the raw text. */
export function errorMessage(raw: string): string {
  let text = raw.replace(/<\/?tool_use_error>/g, '').trim();
  text = text.replace(/^MCP error -?\d+:\s*/, '');
  if (/^The user doesn't want to proceed with this tool use/.test(text)) return 'Rejected by the user';
  text = text.replace(/^PreToolUse:\w+ hook error:\s*/, 'Blocked by a hook: ').replace(/^Blocked by a hook: Blocked:\s*/, 'Blocked by a hook: ');
  const jsonStart = text.search(/[{[]/);
  if (jsonStart >= 0 && jsonStart < 40) {
    try {
      const m = messageFromJson(parseJson(text.slice(jsonStart)));
      if (m) return (text.slice(0, jsonStart) + m).trim();
    } catch { /* not JSON after all */ }
  }
  return text || 'Tool execution failed';
}

interface Identity {
  icon: React.ReactNode;
  label: string;
  detail?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function identify(toolName: string, input: Record<string, unknown>, workingDirectory?: string): Identity {
  const icon = (C: typeof Wrench) => <C size={14} className={cn(tk.text.muted, 'flex-shrink-0')} />;
  const path = str(input?.file_path) && formatFilePath(String(input.file_path), workingDirectory);
  switch (toolName) {
    case 'Bash': return { icon: icon(Terminal), label: str(input?.description) ?? str(input?.command)?.split('\n')[0] ?? 'Bash' };
    case 'Read': return { icon: icon(FileText), label: 'Read', detail: path };
    case 'Edit': case 'MultiEdit': return { icon: icon(Edit), label: 'Edit', detail: path };
    case 'Write': return { icon: icon(FileEdit), label: 'Write', detail: path };
    case 'Grep': case 'Glob': return { icon: icon(Search), label: toolName === 'Grep' ? 'Search' : 'Find files', detail: str(input?.pattern) };
    case 'WebSearch': return { icon: icon(Globe), label: 'Web search', detail: str(input?.query) };
    case 'WebFetch': return { icon: icon(ExternalLink), label: 'Fetch', detail: str(input?.url) };
    default: break;
  }
  if (isMcpTool(toolName)) {
    const detail = str(input?.query) ?? str(input?.url) ?? str(input?.title) ?? str(input?.selector) ?? str(input?.path);
    const brand = brandFor(toolName);
    if (brand) {
      const dark = brand.accentDark ?? brand.accent;
      return {
        icon: (
          <>
            <span style={{ color: brand.accent }} className="flex items-center dark:hidden flex-shrink-0"><brand.Mark size={13} /></span>
            <span style={{ color: dark }} className="hidden dark:flex items-center flex-shrink-0"><brand.Mark size={13} /></span>
          </>
        ),
        label: actionName(toolName),
        detail,
      };
    }
    return { icon: icon(isChromeDevToolsTool(toolName) ? Globe : Plug), label: mcpToolLabel(toolName), detail };
  }
  return { icon: icon(Wrench), label: toolName };
}

export function ToolError({ toolName, toolInput, message: raw, workingDirectory }: {
  toolName: string;
  toolInput: Record<string, unknown>;
  message: string;
  workingDirectory?: string;
}): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const message = errorMessage(raw);
  const firstLine = message.split('\n')[0];
  // Open-able whenever the header cannot show the whole message.
  const canExpand = message.trim() !== firstLine.trim() || firstLine.length > 80;
  const who = identify(toolName, toolInput, workingDirectory);

  return (
    <CollapsibleToolCard
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      canExpand={canExpand}
      cardClassName="!border-red-600/30 dark:!border-rose-400/25"
      headerContent={(
        <>
          <div className="flex items-center gap-2 flex-shrink-0 max-w-[45%] min-w-0">
            {who.icon}
            <span className={cn('text-xs truncate', tk.text.secondary)}>{who.label}</span>
          </div>
          {who.detail && <span className={cn('text-xs truncate min-w-0 max-w-[25%]', tk.text.muted)}>{who.detail}</span>}
          <AlertTriangle size={12} className="text-red-600 dark:text-rose-400/80 flex-shrink-0" />
          <span className="text-xs text-red-700 dark:text-rose-300/80 truncate flex-1 min-w-0">
            {isExpanded ? 'Failed' : firstLine}
          </span>
        </>
      )}
      content={canExpand ? (
        <pre className={cn('m-0 border-t px-3 py-2.5 font-mono text-[12px] whitespace-pre-wrap break-words leading-relaxed', tk.separator, tk.text.primary)}>
          {message}
        </pre>
      ) : undefined}
    />
  );
}
