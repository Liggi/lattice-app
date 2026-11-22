import React, { type JSX } from 'react';
import { Box, PenLine } from 'lucide-react';

/** Who wrote a note on a screenshot: the agent, or you. */
export type MarkKind = 'agent' | 'you';

/** A note drawn on the screenshot: its box in stage px, and what to show. */
export interface Mark {
  key: string;
  kind: MarkKind;
  text: string;
  rect: { left: number; top: number; right: number; bottom: number };
  /** Open in the editor (your note) or picked by a tap or hover. */
  active: boolean;
}

// Yours: the accent. The agent's: dark ink with a light halo, so it shows on light and dark pages alike.
const LINE: Record<MarkKind, { line: string; halo: string }> = {
  you: { line: '#22d3ee', halo: 'rgba(0,0,0,0.6)' },
  agent: { line: '#15171c', halo: 'rgba(255,255,255,0.9)' },
};

/** The author mark beside a note: the agent's cube, or your pen. */
export function AuthorIcon({ kind, size = 13 }: { kind: MarkKind; size?: number }): JSX.Element {
  return kind === 'agent'
    ? <Box size={size} aria-label="Agent's note" className="shrink-0 text-fg-2" />
    : <PenLine size={size} aria-label="Your note" className="shrink-0 text-accent" />;
}

/** Corner brackets on each box; the note text is in the list beside the image. */
export function NoteMarks({
  marks,
  narrow,
  offsetX,
  onHover,
}: {
  marks: Mark[];
  narrow: boolean;
  offsetX: number;
  onHover: (key: string | null) => void;
}): JSX.Element {
  return (
    <>
      {marks.map((m) => {
        const hover = {
          onPointerEnter: (e: React.PointerEvent) => { if (e.pointerType === 'mouse') onHover(m.key); },
          onPointerLeave: () => onHover(null),
        };
        return (
          <React.Fragment key={m.key}>
            <div
              data-image-note-box
              data-note-id={m.key}
              data-mark-kind={m.kind}
              aria-label={`${m.kind === 'you' ? 'Your note' : "Agent's note"}: ${m.text}`}
              {...hover}
              className="absolute cursor-pointer rounded-[2px]"
              style={{
                left: m.rect.left + offsetX,
                top: m.rect.top,
                width: m.rect.right - m.rect.left,
                height: m.rect.bottom - m.rect.top,
                background: m.active ? (m.kind === 'you' ? 'rgba(34,211,238,0.14)' : 'rgba(21,23,28,0.08)') : undefined,
              }}
            >
              <Corners {...LINE[m.kind]} thin={narrow} />
            </div>
          </React.Fragment>
        );
      })}
    </>
  );
}

/** Four corner brackets in place of a full outline, so the marked area stays clear. */
function Corners({ line, halo, thin }: { line: string; halo: string; thin: boolean }): JSX.Element {
  const w = thin ? 1.5 : 2;
  const arm = thin ? 'h-2 w-2' : 'h-3 w-3';
  const edge = (side: 'Left' | 'Right' | 'Top' | 'Bottom') => ({ [`border${side}`]: `${w}px solid ${line}` });
  const glow = { filter: `drop-shadow(0 0 1px ${halo})` };
  const at = thin ? '-2px' : '-3px';
  return (
    <>
      <span className={`absolute ${arm}`} style={{ left: at, top: at, ...edge('Left'), ...edge('Top'), ...glow }} />
      <span className={`absolute ${arm}`} style={{ right: at, top: at, ...edge('Right'), ...edge('Top'), ...glow }} />
      <span className={`absolute ${arm}`} style={{ left: at, bottom: at, ...edge('Left'), ...edge('Bottom'), ...glow }} />
      <span className={`absolute ${arm}`} style={{ right: at, bottom: at, ...edge('Right'), ...edge('Bottom'), ...glow }} />
    </>
  );
}

/** Every note on the image as a list: beside it on a wide screen, under it on a phone. */
export function NotesList({
  notes,
  narrow,
  activeKey,
  onHover,
  onPick,
}: {
  notes: { key: string; kind: MarkKind; text: string; whole: boolean }[];
  narrow: boolean;
  activeKey: string | null;
  onHover: (key: string | null) => void;
  onPick: (key: string) => void;
}): JSX.Element {
  return (
    <ol
      data-image-viewer-notes
      className={narrow
        ? 'max-h-[30vh] shrink-0 overflow-y-auto border-t border-white/10 px-3 py-1'
        : 'w-[300px] shrink-0 overflow-y-auto border-l border-white/10 px-3 py-2'}
    >
      {notes.map((n) => (
        <li key={n.key}>
          <button
            type="button"
            data-note-entry={n.key}
            onPointerEnter={(e) => { if (e.pointerType === 'mouse') onHover(n.key); }}
            onPointerLeave={() => onHover(null)}
            onClick={() => onPick(n.key)}
            className={`flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-[13px] leading-snug ${activeKey === n.key ? 'bg-white/10 text-fg' : 'text-fg/90 hover:bg-white/5'}`}
          >
            <span className="mt-[2px]"><AuthorIcon kind={n.kind} /></span>
            <span className="min-w-0 whitespace-pre-wrap break-words">
              {n.whole && <span className="text-fg-3">Whole image · </span>}
              {n.text}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
