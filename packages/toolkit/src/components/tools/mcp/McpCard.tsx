import React, { useMemo, useState } from 'react';
import { Plug } from 'lucide-react';
import { CollapsibleToolCard } from '../../CollapsibleToolCard.js';
import { tk, accent } from '../../../tokens.js';
import { McpResultBody } from './McpResultBody.js';
import { unwrapResult, summariseResult } from './unwrapResult.js';

interface McpCardProps {
  toolName: string;
  input: Record<string, unknown>;
  result: string;
  isError?: boolean;
}

/** Accepts both `mcp__server__tool` (Claude) and `MCP:server.tool` (Codex adapter). */
function parseMcpName(toolName: string): { server: string; tool: string } {
  const underscore = toolName.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  if (underscore) return { server: underscore[1].replace(/_/g, ' '), tool: underscore[2].replace(/_/g, ' ') };
  const colon = toolName.match(/^MCP:([^.]+)\.(.+)$/i);
  if (colon) return { server: colon[1], tool: colon[2].replace(/_/g, ' ') };
  return { server: '', tool: toolName };
}

const SUMMARY_KEYS = [
  'query', 'search_query', 'path', 'url', 'pattern', 'command', 'prompt', 'code',
  'selector', 'text', 'expression', 'script', 'identifier', 'id', 'value', 'name',
];

/**
 * The arguments a call was made with. Codex passes `{}` as tool input and leaves the
 * real arguments inside the result envelope, so fall back to those when input is empty.
 */
function describeArgs(input: Record<string, unknown>, recovered?: Record<string, unknown>): string {
  const args = Object.keys(input).length > 0 ? input : (recovered ?? {});
  const entries = Object.entries(args).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!entries.length) return '';

  const ordered = [
    ...SUMMARY_KEYS.map((k) => entries.find(([ek]) => ek === k)).filter(Boolean),
    ...entries.filter(([k]) => !SUMMARY_KEYS.includes(k)),
  ] as Array<[string, unknown]>;

  const parts: string[] = [];
  for (const [k, v] of ordered) {
    const val = Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
    parts.push(parts.length === 0 && SUMMARY_KEYS.includes(k) ? val : `${k} ${val}`);
    if (parts.join(' · ').length > 90) break;
  }
  const s = parts.join(' · ');
  return s.length > 100 ? s.slice(0, 99) + '…' : s;
}

/**
 * MCP tool card that describes both sides of the call: what it was asked for, and
 * what came back. The result body renders the payload as whatever it actually is.
 */
export function McpCard({ toolName, input, result, isError }: McpCardProps): React.JSX.Element {
  const { server, tool } = parseMcpName(toolName);
  const unwrapped = useMemo(() => unwrapResult(result ?? ''), [result]);
  const args = describeArgs(input, unwrapped.args);
  const resultSummary = result ? summariseResult(unwrapped) : null;

  // Results stay open. Size is managed inside the body by previewing and saying what
  // is held back — collapsing the whole card hides that a call happened at all.
  const [isExpanded, setIsExpanded] = useState(() => unwrapped.bytes > 0);

  return (
    <CollapsibleToolCard
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      cardClassName={accent.purple.card}
      headerContent={(
        <>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Plug size={14} className={`${accent.purple.icon} flex-shrink-0`} />
            <span className={`text-xs ${tk.text.muted}`}>{tool}</span>
            {server && <span className={`text-[13px] ${tk.text.faint}`}>{server}</span>}
          </div>
          {/*
            What came back outranks what went in. The arguments give up space first —
            a long `evaluate` script would otherwise truncate the summary to "→ t…".
          */}
          {args && (
            <span className={`text-xs ${tk.text.secondary} truncate min-w-0`} style={{ maxWidth: '34%' }}>
              {args}
            </span>
          )}
          {resultSummary && (
            <span className={`text-xs ${tk.text.secondary} truncate flex-1 min-w-0`}>
              <span className={`mr-1 ${tk.text.faint}`}>→</span>
              {resultSummary}
            </span>
          )}
        </>
      )}
      content={(
        <div className={`border-t ${tk.separator}`}>
          <McpResultBody result={result} isError={isError} />
        </div>
      )}
    />
  );
}
