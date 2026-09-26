import React, { useState } from 'react';
import { Globe, ExternalLink } from 'lucide-react';
import { extractDomain } from '../../utils/tool-utils.js';
import { CollapsibleToolCard } from '../CollapsibleToolCard.js';
import { SearchResultContent, FetchResultContent } from '../shared/WebResultContent.js';
import { tk, accent } from '../../tokens.js';

interface WebToolProps {
  input: { query?: string; url?: string };
  result: string;
  toolType: 'WebSearch' | 'WebFetch';
}

const AUTO_EXPAND_THRESHOLD = 5;

export function WebTool({ input, result, toolType }: WebToolProps): React.JSX.Element {
  const isSearch = toolType === 'WebSearch';
  const resultLines = result ? result.split('\n').filter(l => l.trim()).length : 0;
  const [isExpanded, setIsExpanded] = useState(() => resultLines > 0 && resultLines <= AUTO_EXPAND_THRESHOLD);

  const getSummaryText = (): string => {
    if (isSearch) return input?.query || 'Web search';
    const domain = input?.url ? extractDomain(input.url) : '';
    return domain || 'Fetched URL';
  };

  return (
    <CollapsibleToolCard
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      cardClassName={accent.emerald.card}
      headerContent={(
        <>
          <div className="flex items-center gap-2">
            {isSearch ? (
              <Globe size={14} className={`${accent.emerald.icon} flex-shrink-0`} />
            ) : (
              <ExternalLink size={14} className={`${accent.emerald.icon} flex-shrink-0`} />
            )}
            <span className={`text-xs ${tk.text.muted}`}>{isSearch ? 'Search' : 'Fetch'}</span>
          </div>
          <span className={`text-xs ${tk.text.secondary} truncate flex-1`}>{getSummaryText()}</span>
        </>
      )}
      content={result ? (
        <div className={`border-t ${tk.separator} max-h-80 overflow-y-auto ${tk.scrollbar}`}>
          {isSearch ? (
            <SearchResultContent result={result} />
          ) : (
            <FetchResultContent result={result} url={input?.url} />
          )}
        </div>
      ) : undefined}
    />
  );
}
