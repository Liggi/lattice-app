import React, { useLayoutEffect, useRef, useState } from 'react';
import type { PastedSpan } from '@liggi/agent-ui-harness/protocol';
import { AttachedText } from './AttachedText';

/** How much of a long message shows before it is opened: 8 lines at the bubble's line height. */
const CLAMP_LINES = 8;
const LINE_HEIGHT_EM = 1.55;

type Segment = { kind: 'typed'; text: string } | { kind: 'paste'; text: string };

/**
 * Split `text` at its pasted stretches. Each span counts back from the end of
 * the text, so it still points at the paste in text the thread shows without
 * a server-written preamble. A span that does not fit is left as typed text.
 */
export function splitPastes(text: string, pastes: readonly PastedSpan[] | undefined): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  for (const span of pastes ?? []) {
    const start = text.length - span.fromEnd;
    const end = start + span.length;
    if (start < cursor || end > text.length || span.length <= 0) continue;
    if (start > cursor) segments.push({ kind: 'typed', text: text.slice(cursor, start) });
    segments.push({ kind: 'paste', text: text.slice(start, end) });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ kind: 'typed', text: text.slice(cursor) });
  return segments;
}

/**
 * A user message's own words. Pastes are closed rows in their place, with the
 * blank lines around them dropped; a message with none is clamped to its
 * first eight lines as they wrap, and opens in place.
 */
export function UserText({ text, pastes }: { text: string; pastes?: readonly PastedSpan[] }): JSX.Element {
  const segments = splitPastes(text, pastes);
  if (segments.some((segment) => segment.kind === 'paste')) {
    return (
      <div className="flex flex-col gap-2">
        {segments.map((segment, idx) => {
          if (segment.kind === 'paste') {
            return <AttachedText key={idx} kind="paste" label="Pasted text" content={segment.text} />;
          }
          const typed = segment.text.replace(/^\n+|\n+$/g, '');
          return typed.trim() ? <div key={idx} className="whitespace-pre-wrap break-words">{typed}</div> : null;
        })}
      </div>
    );
  }
  return <ClampedText text={text} />;
}

function ClampedText({ text }: { text: string }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [hiddenLines, setHiddenLines] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      if (isExpanded) return;
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 0;
      const overflow = el.scrollHeight - el.clientHeight;
      setHiddenLines(lineHeight > 0 && overflow > 1 ? Math.ceil(overflow / lineHeight) : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, isExpanded]);

  return (
    <div>
      <div
        ref={ref}
        className="whitespace-pre-wrap break-words overflow-hidden"
        style={isExpanded ? undefined : { maxHeight: `${CLAMP_LINES * LINE_HEIGHT_EM}em` }}
      >
        {text}
      </div>
      {(hiddenLines > 0 || isExpanded) && (
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="mt-1 text-fg-3 hover:text-fg-2 transition-colors"
        >
          {isExpanded ? 'Show less' : `… +${hiddenLines} lines`}
        </button>
      )}
    </div>
  );
}
