import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, MessageSquareText, X } from 'lucide-react';
import type { PendingAnnotation } from '../../utils/annotations-format';
import {
  ANNOTATION_BUTTON_BASE,
  ANNOTATION_BUTTON_GHOST,
  ANNOTATION_BUTTON_PRIMARY,
  ANNOTATION_PANEL,
  ANNOTATION_PANEL_HEADER,
  ANNOTATION_PANEL_LABEL,
} from './annotation-styles';

const POPOVER_WIDTH_PX = 340;
const THUMB_W = 72;
const THUMB_H = 52;
const VIEWPORT_MARGIN_PX = 12;

/**
 * Mirrors the toolkit Composer's internal TOUCH_TARGET_44: a transparent
 * pseudo-element gives the control a 44px tap target without changing its
 * visual size or the status bar's layout. The constant is not exported from
 * the package, so the class string is repeated here rather than widening the
 * toolkit's public API for one consumer.
 */
const TOUCH_TARGET_44 =
  "relative before:absolute before:top-1/2 before:left-1/2 before:h-11 before:w-full before:min-w-11 "
  + "before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']";

interface AnnotationStatusBadgeProps {
  annotations: PendingAnnotation[];
  onClearAll: () => void;
  /** Drops one note before it is sent. */
  onRemove: (id: string) => void;
  /**
   * Sends the notes on their own. The toolkit composer refuses an empty submit
   * (`if (!trimmedValue && !hasAttachments) return`), so this is the only route
   * for "notes, no typed message".
   */
  onSendNotesOnly: () => void;
  sendDisabled?: boolean;
  /** How many of the notes are on a send the server has not answered yet. */
  sendingCount?: number;
}

/**
 * Pending-note count, shown next to the model badge in the composer status bar
 * via the toolkit's `renderStatusExtra` slot.
 *
 * This is the fallback surface for notes whose source message has been
 * unmounted by the transcript's block budgeting, so the count is always the
 * true pending count — not the number of visible highlighted spans.
 */
export function AnnotationStatusBadge({
  annotations,
  onClearAll,
  onRemove,
  onSendNotesOnly,
  sendDisabled = false,
  sendingCount = 0,
}: AnnotationStatusBadgeProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const count = annotations.length;
  const countLabel = count === 1 ? '1 note' : `${count} notes`;
  const sending = sendingCount > 0;
  const sendingLabel = `Sending ${sendingCount === 1 ? '1 note' : `${sendingCount} notes`}`;

  // Nothing pending, nothing to show — and close a popover left open.
  useEffect(() => {
    if (count === 0 && open) setOpen(false);
  }, [count, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: Event) => {
      const target = event.target as Element | null;
      if (target?.closest?.('[data-annotation-ui="true"]')) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      if (prev) return false;
      const rect = buttonRef.current?.getBoundingClientRect();
      // Lined up with the composer's edges, so the popover reads as part of it.
      const bar = buttonRef.current?.closest('[data-testid="composer-status-bar"]')?.getBoundingClientRect();
      if (rect) setAnchor({ top: rect.top, left: bar?.left ?? VIEWPORT_MARGIN_PX, right: bar?.right ?? window.innerWidth - VIEWPORT_MARGIN_PX });
      return true;
    });
  }, []);

  if (count === 0) return null;

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 768;
  const span = anchor ? anchor.right - anchor.left : viewportWidth - 2 * VIEWPORT_MARGIN_PX;
  // A phone gets the composer's full width; a wider screen a column at its right edge.
  const width = viewportWidth < 640 ? span : Math.min(POPOVER_WIDTH_PX, span);
  const left = anchor ? anchor.right - width : VIEWPORT_MARGIN_PX;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-annotation-ui="true"
        data-testid="annotation-status-badge"
        data-pending-count={count}
        data-sending={sending || undefined}
        aria-label={sending ? sendingLabel : `${countLabel} pending`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={sending ? `${sendingLabel}…` : count === 1 ? '1 note pending — sends with your next message' : `${count} notes pending — send with your next message`}
        onClick={toggle}
        // Geometry mirrors its neighbours in the composer foot (the model badge
        // and the token counter): a 28px-tall text badge with a surface hover.
        className={`${TOUCH_TARGET_44} flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-accent transition-colors cursor-pointer hover:bg-accent-soft`}
        style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
      >
        {sending
          ? <Loader2 size={12} className="shrink-0 animate-spin" />
          : <MessageSquareText size={12} className="shrink-0" />}
        <span
          className="whitespace-nowrap tabular-nums"
          data-testid="annotation-status-count"
        >
          {sending ? sendingLabel : count}
        </span>
      </button>

      {open && typeof document !== 'undefined' && createPortal(
        <div
          data-annotation-ui="true"
          data-testid="annotation-status-popover"
          className={`fixed z-50 overflow-hidden ${ANNOTATION_PANEL}`}
          style={{
            // Anchored above the badge, so it never covers the composer input.
            bottom: Math.max(VIEWPORT_MARGIN_PX, viewportHeight - (anchor?.top ?? viewportHeight) + 8),
            left,
            width,
            touchAction: 'manipulation',
          }}
        >
          <div className={ANNOTATION_PANEL_HEADER}>
            <MessageSquareText size={12} className="text-fg-3 flex-shrink-0" />
            <span className={ANNOTATION_PANEL_LABEL}>
              {sending ? `${sendingLabel}…` : 'Notes for your next message'}
            </span>
          </div>
          <ol
            data-testid="annotation-status-list"
            className="max-h-[min(60vh,420px)] overflow-y-auto overflow-x-hidden"
          >
            {annotations.map((annotation) => (
              <li
                key={annotation.id}
                data-testid="annotation-status-item"
                className="flex items-start gap-2.5 border-b border-line py-2 pl-3 pr-1"
              >
                {annotation.image && <BoxThumb src={annotation.image.src} box={annotation.image.box} />}
                <div className="min-w-0 flex-1 py-0.5">
                  <div className="break-words text-xs leading-snug text-fg-3">
                    {annotation.image ? annotation.quote : `“${annotation.quote}”`}
                  </div>
                  <div className="mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-snug text-fg">
                    {annotation.note}
                  </div>
                </div>
                <button
                  type="button"
                  data-testid="annotation-status-remove"
                  aria-label="Remove this note"
                  title="Remove this note"
                  disabled={sending}
                  onClick={() => onRemove(annotation.id)}
                  className={`${TOUCH_TARGET_44} grid h-7 w-7 shrink-0 place-items-center rounded-sm text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-40 cursor-pointer`}
                  style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ol>
          <div className="flex items-center justify-between gap-1 px-1">
            <button
              type="button"
              data-testid="annotation-clear-all"
              onClick={() => { onClearAll(); setOpen(false); }}
              disabled={sending}
              className={`${ANNOTATION_BUTTON_BASE} ${ANNOTATION_BUTTON_GHOST} px-2 disabled:opacity-40`}
              style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
            >
              Clear all
            </button>
            <button
              type="button"
              data-testid="annotation-send-notes"
              onClick={() => { onSendNotesOnly(); setOpen(false); }}
              disabled={sendDisabled || sending}
              className={`${ANNOTATION_BUTTON_BASE} ${ANNOTATION_BUTTON_PRIMARY} px-2`}
              style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
              title="Send just these notes, with no message text"
            >
              {sending ? 'Sending…' : 'Send notes now'}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * The part of a screenshot a note is about: the box with some of the image
 * around it, scaled to fill a small tile, and the box outlined in the accent.
 */
function BoxThumb({ src, box }: { src: string; box: { x: number; y: number; w: number; h: number } }): JSX.Element {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  let img: React.CSSProperties = { visibility: 'hidden' };
  let outline: React.CSSProperties | null = null;
  if (natural) {
    const bw = box.w * natural.w;
    const bh = box.h * natural.h;
    // The box nearly fills the tile, so what it marks is as legible as the tile allows.
    const scale = Math.min((THUMB_W * 0.92) / bw, (THUMB_H * 0.92) / bh);
    const cx = (box.x + box.w / 2) * natural.w * scale;
    const cy = (box.y + box.h / 2) * natural.h * scale;
    const left = THUMB_W / 2 - cx;
    const top = THUMB_H / 2 - cy;
    img = { position: 'absolute', left, top, width: natural.w * scale, height: natural.h * scale, maxWidth: 'none' };
    outline = { left: left + box.x * natural.w * scale, top: top + box.y * natural.h * scale, width: bw * scale, height: bh * scale };
  }
  return (
    <div
      aria-hidden
      data-testid="annotation-status-thumb"
      className="relative shrink-0 overflow-hidden rounded-sm border border-line bg-black"
      style={{ width: THUMB_W, height: THUMB_H }}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        style={img}
      />
      {outline && (
        <div className="absolute rounded-[2px]" style={{ ...outline, boxShadow: '0 0 0 1.5px #22d3ee' }} />
      )}
    </div>
  );
}
