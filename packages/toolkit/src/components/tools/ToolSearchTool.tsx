import React, { useState } from 'react';
import { Search } from 'lucide-react';
import { CollapsibleToolCard } from '../CollapsibleToolCard.js';
import { tk, accent } from '../../tokens.js';

interface ToolSearchToolProps {
  input: { query?: string; max_results?: number };
  result: string;
}

interface ParsedTool {
  raw: string;
  server?: string;
  label: string;
}

function parseToolNames(result: string): ParsedTool[] {
  try {
    const parsed = JSON.parse(result);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item: { tool_name?: string }) => item.tool_name)
        .map((item: { tool_name: string }) => {
          const name = item.tool_name;
          const match = name.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
          if (match) return { raw: name, server: match[1].replace(/_/g, ' '), label: match[2].replace(/_/g, ' ') };
          return { raw: name, label: name };
        });
    }
  } catch { /* not JSON */ }
  return [];
}

export function ToolSearchTool({ input, result }: ToolSearchToolProps): React.JSX.Element {
  const query = input?.query || '';
  const tools = parseToolNames(result);
  const hasResult = tools.length > 0;
  const [isExpanded, setIsExpanded] = useState(() => hasResult);

  return (
    <CollapsibleToolCard
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      cardClassName={accent.violet.card}
      canExpand={hasResult}
      headerContent={(
        <>
          <div className="flex items-center gap-2">
            <Search size={14} className={`${accent.violet.icon} flex-shrink-0`} />
            <span className={`text-xs ${tk.text.muted}`}>Tools</span>
          </div>
          <span className={`text-xs ${tk.text.secondary} truncate flex-1`}>{query}</span>
          {hasResult && <span className={`text-[13px] ${tk.text.faint}`}>{tools.length} found</span>}
        </>
      )}
      content={hasResult ? (
        <div className={`border-t ${tk.separator} px-3 py-2 flex flex-wrap gap-1.5`}>
          {tools.map((tool) => (
            <span key={tool.raw} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[13px] ${tk.codeBgSubtle}`}>
              {tool.server && <span className={tk.text.faint}>{tool.server}:</span>}
              <span className={tk.text.secondary}>{tool.label}</span>
            </span>
          ))}
        </div>
      ) : undefined}
    />
  );
}
