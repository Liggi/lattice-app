/**
 * A bold term in an article, with its generated explanation on hover.
 *
 * Ported from thekg.io's `StrongText` in `src/components/markdown-display.tsx`.
 * A term with no tooltip renders as plain bold text, so an article whose
 * tooltips have not been generated reads exactly as it did before.
 *
 * The tooltip panel is built on Radix primitives directly rather than this
 * repo's `TooltipContent`, because it holds a body of markdown and an action
 * rather than a one-line hint; its surface is the app's own panel — 10px
 * radius, `bg-surface`, a `border-line` hairline, no shadow and no blur.
 *
 * Lookup is case-insensitive. The generator stores keys verbatim; thekg.io
 * lowercased them. Normalising here means either convention resolves, and a
 * term bolded as "EventLog" in one paragraph and "eventlog" in another still
 * finds its explanation.
 */

import { useMemo, useState } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Info, Loader2 } from 'lucide-react';
import { NoteMarkdown } from './ArticleMarkdown';

export type TooltipMap = Record<string, string>;

/** Case-insensitive lookup over whatever key casing the tooltips were stored with. */
export function normalizeTooltips(tooltips: TooltipMap): TooltipMap {
  const normalized: TooltipMap = {};
  for (const [concept, text] of Object.entries(tooltips)) {
    normalized[concept.trim().toLowerCase()] = text;
  }
  return normalized;
}

export interface ConceptTooltipProps {
  concept: string;
  tooltip: string | undefined;
  /** Spawns a child article about this concept. Absent = no action offered. */
  onLearnMore?: (concept: string) => void;
  /** True while a "tell me more" article is being created. */
  isCreatingArticle?: boolean;
}

export function ConceptTooltip({
  concept,
  tooltip,
  onLearnMore,
  isCreatingArticle = false,
}: ConceptTooltipProps): JSX.Element {
  const [open, setOpen] = useState(false);

  if (!tooltip) {
    return <strong className="font-medium text-fg">{concept}</strong>;
  }

  return (
    <TooltipPrimitive.Root open={open} onOpenChange={setOpen} delayDuration={200}>
      <TooltipPrimitive.Trigger asChild>
        <span
          data-testid="km-concept-term"
          className="font-medium text-fg cursor-help relative border-b border-line-2 hover:bg-surface-2 transition-colors duration-150"
        >
          {concept}
        </span>
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          data-testid="km-concept-tooltip"
          sideOffset={5}
          style={{ maxWidth: '500px', willChange: 'opacity, transform' }}
          className="z-50 p-4 text-sm bg-surface text-fg border border-line rounded-lg"
        >
          <NoteMarkdown content={tooltip} />
          {onLearnMore && (
            <div className="mt-3 pt-3 border-t border-line">
              <button
                type="button"
                disabled={isCreatingArticle}
                onClick={() => onLearnMore(concept)}
                className={`px-3 py-1.5 rounded-sm text-xs font-medium transition-colors flex items-center gap-1.5 ${
                  isCreatingArticle
                    ? 'text-fg-3 cursor-not-allowed'
                    : 'text-accent hover:bg-accent-soft'
                }`}
              >
                <span>
                  {isCreatingArticle ? <Loader2 size={12} className="animate-spin" /> : <Info size={12} />}
                </span>
                {isCreatingArticle ? 'Creating…' : 'Tell me more about this'}
              </button>
            </div>
          )}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/** Reads the plain text of a `<strong>`'s children, which is the concept key. */
export function conceptTextOf(children: React.ReactNode): string {
  if (typeof children === 'string') return children.trim();
  if (Array.isArray(children)) return children.map(conceptTextOf).join('').trim();
  return String(children ?? '').trim();
}

/** Memoised normaliser for a component that re-renders on every stream tick. */
export function useNormalizedTooltips(tooltips: TooltipMap | undefined): TooltipMap {
  return useMemo(() => normalizeTooltips(tooltips ?? {}), [tooltips]);
}
