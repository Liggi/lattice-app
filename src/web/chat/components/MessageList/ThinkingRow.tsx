import { type JSX, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { preserveThinkingBreaks } from '../../utils/thinking-text';

/**
 * A thinking block as one dim line, "Thought", that opens to the whole text
 * on click, so the thread reads as the conversation and nothing is lost.
 */
export function ThinkingRow({ text, components }: { text: string; components: Components }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="max-w-[68ch]" data-testid="thinking-block">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="group flex items-center gap-1.5 py-0.5 text-[13px] text-fg-3 hover:text-fg-2 cursor-pointer"
      >
        <ChevronRight size={12} className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
        <span>Thought</span>
      </button>
      {open && (
        <div className="pb-1 pl-[18px] pt-1 prose max-w-none text-[13px] leading-relaxed text-fg-3 dark:prose-invert [&_p]:text-fg-3">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{preserveThinkingBreaks(text)}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
