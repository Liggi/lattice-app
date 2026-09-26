import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, MessageSquareText } from 'lucide-react';
import type { PendingAnnotation } from '../../utils/annotations-format';
import {
  ANNOTATION_BUTTON_BASE,
  ANNOTATION_BUTTON_GHOST,
  ANNOTATION_BUTTON_PRIMARY,
  ANNOTATION_PANEL,
  ANNOTATION_PANEL_HEADER,
  ANNOTATION_PANEL_LABEL,
} from './annotation-styles';

const POPOVER_WIDTH_PX = 220;
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
  onSendNotesOnly,
  sendDisabled = false,
  sendingCount = 0,
}: AnnotationStatusBadgeProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
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
      if (rect) setAnchor({ top: rect.top, left: rect.left + rect.width / 2 });
      return true;
    });
  }, []);

  if (count === 0) return null;

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 768;
  const width = Math.min(POPOVER_WIDTH_PX, viewportWidth - 2 * VIEWPORT_MARGIN_PX);
  const left = anchor
    ? Math.min(
      Math.max(anchor.left - width / 2, VIEWPORT_MARGIN_PX),
      Math.max(VIEWPORT_MARGIN_PX, viewportWidth - width - VIEWPORT_MARGIN_PX),
    )
    : VIEWPORT_MARGIN_PX;

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
              {sending ? `${sendingLabel}…` : `${countLabel} pending`}
            </span>
          </div>
          <div className="px-3 pt-2 text-xs leading-snug text-fg-3">
            Rides at the front of your next message.
          </div>
          <div className="flex items-center justify-between gap-1 px-2 pb-2 pt-1">
            <button
              type="button"
              data-testid="annotation-clear-all"
              onClick={() => { onClearAll(); setOpen(false); }}
              className={`${ANNOTATION_BUTTON_BASE} ${ANNOTATION_BUTTON_GHOST} px-2`}
              style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
            >
              Clear all
            </button>
            <button
              type="button"
              data-testid="annotation-send-notes"
              onClick={() => { onSendNotesOnly(); setOpen(false); }}
              disabled={sendDisabled || sending}
              className={`${ANNOTATION_BUTTON_BASE} ${ANNOTATION_BUTTON_PRIMARY} px-3`}
              style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
              title="Send just these notes, with no message text"
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
