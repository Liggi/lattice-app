import React, { useLayoutEffect, useRef, useState } from 'react';
import type { ParsedAnnotatedMessage } from '../../utils/annotations-format';

/**
 * A highlighted passage, set in a darker inset. Clamped to three lines; a
 * longer one opens and closes on click. The note below it is never clamped.
 */
function QuotedPassage({ quote }: { quote: string }): JSX.Element {
  const textRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, quote]);

  // One element tree whether or not it overflows, so the observed node is never swapped out.
  const toggle = overflows || expanded;
  return (
    <div
      className={`rounded-md bg-bg px-2.5 py-1.5 text-[13px] leading-[1.5] text-fg-2${toggle ? ' cursor-pointer hover:text-fg transition-colors duration-100' : ''}`}
      onClick={toggle ? () => setExpanded((open) => !open) : undefined}
      data-testid="annotated-quote"
    >
      <div ref={textRef} className={`whitespace-pre-wrap break-words ${expanded ? '' : 'line-clamp-3'}`}>
        {quote}
      </div>
      {toggle && (
        <button
          type="button"
          className="mt-0.5 block text-[11px] text-fg-3 cursor-pointer"
          aria-expanded={expanded}
          onClick={(event) => { event.stopPropagation(); setExpanded((open) => !open); }}
        >
          {expanded ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

/** Body of a user bubble whose text is a notes block: passage, then note, then anything typed after. */
export function AnnotatedUserMessage({ parsed }: { parsed: ParsedAnnotatedMessage }): JSX.Element {
  return (
    <div className="flex flex-col" data-testid="annotated-message">
      {parsed.annotations.map((annotation, index) => (
        <div key={index} className={`flex flex-col gap-1.5 ${index === 0 ? '' : 'mt-3.5'}`}>
          {/* Selections often carry a stray edge space or newline; the sent text keeps it. */}
          <QuotedPassage quote={annotation.quote.trim()} />
          <div className="whitespace-pre-wrap break-words">{annotation.note}</div>
        </div>
      ))}
      {parsed.body && (
        <div className="mt-3 pt-2.5 border-t border-line whitespace-pre-wrap break-words">
          {parsed.body}
        </div>
      )}
    </div>
  );
}
