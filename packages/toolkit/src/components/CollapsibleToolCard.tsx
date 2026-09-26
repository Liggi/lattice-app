import React from 'react';
import { ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible.js';
import { cn } from '../utils/cn.js';
import { tk } from '../tokens.js';

interface CollapsibleToolCardProps {
  isExpanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  headerContent: React.ReactNode;
  content?: React.ReactNode;
  canExpand?: boolean;
  wrapperClassName?: string;
  cardClassName?: string;
  headerClassName?: string;
  /**
   * Inline card styling, for accents that cannot be expressed as a Tailwind class —
   * brand colours arriving at runtime inside an MCP payload, for example.
   */
  cardStyle?: React.CSSProperties;
}

export function CollapsibleToolCard({
  isExpanded,
  onExpandedChange,
  headerContent,
  content,
  canExpand = true,
  wrapperClassName,
  cardClassName,
  headerClassName,
  cardStyle,
}: CollapsibleToolCardProps): React.JSX.Element {
  return (
    <div className={cn('w-fit max-w-full', wrapperClassName)}>
      <Collapsible open={isExpanded} onOpenChange={onExpandedChange}>
        <div
          className={cn(
            'border rounded-lg overflow-hidden',
            tk.card.border,
            tk.card.bg,
            cardClassName,
          )}
          style={cardStyle}
        >
          <CollapsibleTrigger
            className="w-full text-left cursor-pointer select-none"
            disabled={!canExpand}
          >
            <div className={cn(
              'flex items-center gap-2 px-3 py-2 transition-colors',
              canExpand && tk.hover,
              headerClassName,
            )}>
              {headerContent}
              {canExpand && (
                <ChevronDown
                  size={12}
                  className={cn(
                    'transition-transform duration-150 flex-shrink-0',
                    tk.text.faint,
                    !isExpanded && '-rotate-90',
                  )}
                />
              )}
            </div>
          </CollapsibleTrigger>
          {canExpand && content && (
            <CollapsibleContent>{content}</CollapsibleContent>
          )}
        </div>
      </Collapsible>
    </div>
  );
}
