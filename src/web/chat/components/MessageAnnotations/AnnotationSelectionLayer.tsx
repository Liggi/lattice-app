import React, { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageCircleQuestion, MessageSquare, MessageSquarePlus, Trash2 } from 'lucide-react';
import {
  isInsideAnnotationUi,
  readAssistantSelection,
  type AssistantSelectionTarget,
  type SelectionReader,
} from '../../utils/annotation-selection';
import {
  computeDockedBarPlacement,
  computeKeyboardInset,
  shouldDockAnnotationUi,
} from '../../utils/annotation-viewport';
import {
  ANNOTATION_BUTTON_BASE,
  ANNOTATION_BUTTON_GHOST,
  ANNOTATION_BUTTON_PRIMARY,
  ANNOTATION_PANEL,
  ANNOTATION_PANEL_HEADER,
  ANNOTATION_PANEL_LABEL,
  ANNOTATION_ICON_BUTTON,
  ANNOTATION_ICON_BUTTON_PX,
  ANNOTATION_TOOLBAR,
  ANNOTATION_TOOLBAR_BUTTON,
} from './annotation-styles';
import { useCoarsePointer, useVisualViewport } from '../../hooks/useVisualViewport';

const POPOVER_WIDTH_PX = 340;
const VIEWPORT_MARGIN_PX = 12;
/**
 * How long a selection must stay gone before the pill hides. Long enough to
 * ride out the collapsed states iOS passes through while the drag handles are
 * being moved, short enough that a deliberate dismissal still feels immediate.
 */
export const SELECTION_HIDE_DELAY_MS = 300;
export const COMPOSER_BOX_SELECTOR = '[data-composer-box="true"]';

/** Horizontal placement for a fixed element anchored to a selection rect. */
export function computeAnchoredLeft(
  rect: { left: number; right: number } | null,
  elementWidth: number,
  viewportWidth: number,
): number {
  const centre = rect ? (rect.left + rect.right) / 2 : viewportWidth / 2;
  const ideal = centre - elementWidth / 2;
  const max = Math.max(VIEWPORT_MARGIN_PX, viewportWidth - elementWidth - VIEWPORT_MARGIN_PX);
  return Math.min(Math.max(ideal, VIEWPORT_MARGIN_PX), max);
}

/**
 * Vertical placement. Prefers above the selection on all pointer types — iOS
 * 16+ draws its edit menu below the selection, so below-placement gets covered.
 * `minTop` is the top of the visible transcript, so "above" never lands on the
 * header over it.
 */
export function computeAnchoredTop(
  rect: { top: number; bottom: number } | null,
  elementHeight: number,
  viewportHeight: number,
  minTop = VIEWPORT_MARGIN_PX,
): number {
  if (!rect) return Math.max(VIEWPORT_MARGIN_PX, viewportHeight / 3);
  const below = rect.bottom + 8;
  const above = rect.top - elementHeight - 8;
  const fitsAbove = above >= minTop;
  const top = fitsAbove ? above : below;
  const max = Math.max(VIEWPORT_MARGIN_PX, viewportHeight - elementHeight - VIEWPORT_MARGIN_PX);
  return Math.min(Math.max(top, VIEWPORT_MARGIN_PX), max);
}

/** The visible band of the nearest scrolling ancestor, or the viewport. */
function visibleBandOf(node: Node | null): { top: number; bottom: number } {
  let element = node instanceof Element ? node : node?.parentElement ?? null;
  while (element) {
    const overflowY = getComputedStyle(element).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    }
    element = element.parentElement;
  }
  return { top: 0, bottom: window.innerHeight };
}

/** A selection target plus the top of the transcript's visible band. */
type AnchoredTarget = AssistantSelectionTarget & { visibleTop?: number };

interface AnnotationSelectionLayerProps {
  /** Called when the user confirms a note for the captured span. */
  onAdd: (input: {
    messageId: string;
    quote: string;
    note: string;
    quoteStart: number | null;
  }) => void;
  /** Turns the live selection into an annotation target. Defaults to assistant messages. */
  readSelection?: SelectionReader;
  /**
   * More actions for the selected message, beside "Add note" in the docked
   * (touch) bar: a long-press on the words has to stay a selection, so this
   * bar is where touch reaches per-message actions.
   */
  renderDockedActions?: (messageId: string) => React.ReactNode;
  /** Opens a side question about the captured span. Shows Ask beside Add note. */
  onAsk?: (target: AssistantSelectionTarget) => void;
}

interface NoteEditorProps {
  /** Set when editing an existing note: changes the header and adds Delete. */
  onDelete?: () => void;
  quote: string;
  note: string;
  onNoteChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

/** Quote preview + textarea + save/cancel, for adding a note or editing one. */
export function NoteEditor({ quote, note, onNoteChange, onSubmit, onCancel, onDelete, inputRef }: NoteEditorProps): JSX.Element {
  const HeaderIcon = onDelete ? MessageSquare : MessageSquarePlus;
  return (
    <>
      {/* Header strip: hairline rule, 12px glyph, small label. */}
      <div className={ANNOTATION_PANEL_HEADER}>
        <HeaderIcon size={12} className="text-fg-3 flex-shrink-0" />
        <span className={ANNOTATION_PANEL_LABEL}>{onDelete ? 'Your note' : 'Note on selection'}</span>
      </div>
      {/* Quoted excerpt, muted and in quotation marks, above the note. */}
      <div className="mx-3 mt-2 text-xs leading-[1.45] text-fg-3 line-clamp-3 break-words">
        {`\u201C${quote}\u201D`}
      </div>
      <textarea
        ref={inputRef}
        data-testid="annotation-note-input"
        value={note}
        onChange={(event) => onNoteChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
        rows={2}
        placeholder="What about this?"
        className="w-full resize-none bg-transparent px-3 py-2 text-sm leading-relaxed text-fg outline-none placeholder:text-fg-3"
      />
      {/* Ghost Cancel / accent Save — the app's tertiary + primary pair. */}
      <div className="flex items-center justify-end gap-1 px-2 pb-2">
        {onDelete && (
          <button
            type="button"
            data-testid="annotation-note-delete"
            aria-label="Delete note"
            onClick={onDelete}
            className={`${ANNOTATION_BUTTON_BASE} mr-auto flex min-w-[44px] items-center justify-center text-fg-3 hover:text-rose-300`}
            style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
          >
            <Trash2 size={14} />
          </button>
        )}
        <button
          type="button"
          data-testid="annotation-note-cancel"
          onClick={onCancel}
          className={`${ANNOTATION_BUTTON_BASE} ${ANNOTATION_BUTTON_GHOST} min-w-[44px] px-3`}
          style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="annotation-note-save"
          onClick={onSubmit}
          disabled={note.trim() === ''}
          className={`${ANNOTATION_BUTTON_BASE} ${ANNOTATION_BUTTON_PRIMARY} min-w-[44px] px-3`}
          style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
        >
          Save
        </button>
      </div>
    </>
  );
}

/**
 * Watches for text selections inside assistant messages and offers to attach a
 * note to them.
 *
 * The message id and quoted text are copied out of the DOM the moment the
 * selection settles, so the annotation survives the source message being
 * unmounted by the transcript's block budgeting.
 *
 * Two layouts. On a mouse, the "Add note" pill and the note editor anchor to
 * the selection rect. On touch (or a narrow viewport) both dock at the
 * composer instead: the bar covers the composer card, and the
 * editor becomes a bottom sheet pinned to the visual viewport so it rides above
 * the software keyboard.
 */
export function AnnotationSelectionLayer({
  onAdd,
  readSelection = readAssistantSelection,
  renderDockedActions,
  onAsk,
}: AnnotationSelectionLayerProps): JSX.Element | null {
  const [target, setTarget] = useState<AnchoredTarget | null>(null);
  const [composing, setComposing] = useState<AssistantSelectionTarget | null>(null);
  const [note, setNote] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  composingRef.current = composing !== null;
  /** Set by the docked pill's touch handler so the ghost click is ignored. */
  const touchedRef = useRef(false);
  /** Bridges the watcher effect's debounce timer out to the open handler. */
  const hideTargetNowRef = useRef<(() => void) | null>(null);
  /** The composer card's box, which the touch bar covers. */
  const [composerBox, setComposerBox] = useState<{ top: number; bottom: number; left: number; right: number } | null>(null);

  const viewport = useVisualViewport();
  const coarsePointer = useCoarsePointer();
  const docked = shouldDockAnnotationUi(coarsePointer, viewport.width);
  const dockedRef = useRef(docked);
  dockedRef.current = docked;

  // --- Selection watching -------------------------------------------------
  useEffect(() => {
    let frame = 0;
    let hideTimer = 0;

    const refresh = () => {
      // Freeze the captured span while the note is being typed: focusing the
      // textarea collapses the document selection.
      if (composingRef.current) return;
      const selection = typeof window !== 'undefined' ? window.getSelection() : null;
      if (selection && isInsideAnnotationUi(selection.anchorNode)) return;

      let next: AnchoredTarget | null = readSelection(selection);
      // The pill anchors to a snapshot of the rect, so this re-reads on scroll.
      // A selection scrolled out of the transcript's visible band has nothing
      // to anchor to. The docked bar does not anchor, so it is left alone.
      if (next?.rect && selection && !dockedRef.current) {
        const band = visibleBandOf(selection.anchorNode);
        next = next.rect.bottom <= band.top || next.rect.top >= band.bottom
          ? null
          : { ...next, visibleTop: band.top };
      }
      if (next) {
        // Appearing is immediate — the affordance should feel instant.
        if (hideTimer) {
          window.clearTimeout(hideTimer);
          hideTimer = 0;
        }
        setTarget(next);
        return;
      }

      // Disappearing is debounced. Dragging the iOS selection handles walks the
      // selection through momentarily-collapsed states, which would otherwise
      // strobe the button on and off.
      if (hideTimer) return;
      hideTimer = window.setTimeout(() => {
        hideTimer = 0;
        setTarget(null);
      }, SELECTION_HIDE_DELAY_MS);
    };

    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        refresh();
      });
    };

    hideTargetNowRef.current = () => {
      if (hideTimer) {
        window.clearTimeout(hideTimer);
        hideTimer = 0;
      }
      setTarget(null);
    };

    // selectionchange covers touch (including the iOS drag-handle adjust
    // gesture); mouseup/touchend make desktop drag-select feel immediate.
    document.addEventListener('selectionchange', schedule);
    document.addEventListener('mouseup', schedule);
    document.addEventListener('touchend', schedule);
    // Scrolling moves the selection under a fixed-position pill. Capture phase,
    // because the transcript scrolls in its own container and scroll does not bubble.
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (hideTimer) window.clearTimeout(hideTimer);
      hideTargetNowRef.current = null;
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('mouseup', schedule);
      document.removeEventListener('touchend', schedule);
      document.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, [readSelection]);

  // Dismiss the note editor on Escape or on a pointer press outside it.
  useEffect(() => {
    if (!composing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setComposing(null);
        setNote('');
      }
    };
    const onPointerDown = (event: Event) => {
      if (isInsideAnnotationUi(event.target as Node)) return;
      setComposing(null);
      setNote('');
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [composing]);

  useEffect(() => {
    if (composing) inputRef.current?.focus();
  }, [composing]);

  // Measure the composer so the touch bar can sit over it.
  // Only while a bar is actually pending, and never during composing.
  useEffect(() => {
    if (!docked || !target || composing) return;
    if (typeof document === 'undefined') return;
    const box = document.querySelector(COMPOSER_BOX_SELECTOR);
    if (!box) {
      setComposerBox((prev) => (prev === null ? prev : null));
      return;
    }
    // The box pads the card in from the screen edges; the bar covers the card.
    const rect = box.getBoundingClientRect();
    const style = getComputedStyle(box);
    const next = {
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      left: Math.round(rect.left + parseFloat(style.paddingLeft || '0')),
      right: Math.round(rect.right - parseFloat(style.paddingRight || '0')),
    };
    setComposerBox((prev) => (
      prev && prev.top === next.top && prev.bottom === next.bottom && prev.left === next.left && prev.right === next.right
        ? prev
        : next
    ));
  }, [docked, target, composing, viewport.height, viewport.width, viewport.offsetTop]);

  const openComposer = useCallback(() => {
    if (!target) return;
    setComposing(target);
    // Bypass the hide debounce — opening the editor should retire the pill at
    // once, not 300ms later.
    hideTargetNowRef.current?.();
    setTarget(null);
    setNote('');
  }, [target]);

  const openAsk = useCallback(() => {
    if (!target || !onAsk) return;
    hideTargetNowRef.current?.();
    setTarget(null);
    // The side chat marks the passage itself; a live selection would bring this toolbar back.
    window.getSelection()?.removeAllRanges();
    onAsk(target);
  }, [target, onAsk]);

  const cancel = useCallback(() => {
    setComposing(null);
    setNote('');
  }, []);

  const submit = useCallback(() => {
    if (!composing) return;
    const trimmed = note.trim();
    if (trimmed === '') return;
    onAdd({
      messageId: composing.messageId,
      quote: composing.quote,
      note: trimmed,
      quoteStart: composing.quoteStart,
    });
    setComposing(null);
    setNote('');
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      // Selection clearing is cosmetic.
    }
  }, [composing, note, onAdd]);

  // Portalled to <body>: the composer dock this renders inside has
  // `backdrop-blur`, and backdrop-filter makes an element a containing block
  // for position:fixed descendants — a fixed overlay would be trapped in it.
  const portalHost = typeof document !== 'undefined' ? document.body : null;
  if (!portalHost) return null;

  const editor = composing ? (
    <NoteEditor
      quote={composing.quote}
      note={note}
      onNoteChange={setNote}
      onSubmit={submit}
      onCancel={cancel}
      inputRef={inputRef}
    />
  ) : null;

  if (composing && docked) {
    // Bottom sheet: pinned to the bottom of the *visual* viewport so it stays
    // visible while the software keyboard is open.
    const keyboardInset = computeKeyboardInset(viewport.layoutHeight, viewport);
    return createPortal(
      <div
        data-annotation-ui="true"
        data-testid="annotation-note-sheet"
        className={`fixed z-50 overflow-hidden ${ANNOTATION_PANEL}`}
        style={{
          left: VIEWPORT_MARGIN_PX,
          right: VIEWPORT_MARGIN_PX,
          bottom: keyboardInset + VIEWPORT_MARGIN_PX,
          touchAction: 'manipulation',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        {editor}
      </div>,
      portalHost,
    );
  }

  if (composing) {
    const width = Math.min(POPOVER_WIDTH_PX, viewport.width - 24);
    const left = computeAnchoredLeft(composing.rect, width, viewport.width);
    const top = computeAnchoredTop(composing.rect, 168, viewport.height);
    return createPortal(
      <div
        data-annotation-ui="true"
        data-testid="annotation-note-popover"
        className={`fixed z-50 overflow-hidden ${ANNOTATION_PANEL}`}
        style={{
          top,
          left,
          width,
          touchAction: 'manipulation',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        {editor}
      </div>,
      portalHost,
    );
  }

  if (!target) return null;

  if (docked) {
    // Floating and portalled, covering the composer card. Not above the
    // composer (it covered the transcript's last lines, where the bottom of a
    // message being selected sits), not selection-anchored (that collides
    // with the iOS edit menu) and not in normal flow (that shifted the
    // composer area every time the bar appeared).
    const keyboardInset = computeKeyboardInset(viewport.layoutHeight, viewport);
    const placement = computeDockedBarPlacement(composerBox, keyboardInset);
    return createPortal(
      <div
        data-annotation-ui="true"
        data-testid="annotation-docked-bar"
        className={`fixed z-50 whitespace-nowrap ${ANNOTATION_TOOLBAR} ${placement.over ? 'justify-evenly' : ''}`}
        style={placement.over
          ? { top: placement.top, left: placement.left, width: placement.width, height: placement.height }
          : { bottom: placement.bottom, left: '50%', transform: 'translateX(-50%)' }}
      >
        <button
          type="button"
          data-annotation-ui="true"
          data-testid="annotation-add-button"
          onMouseDown={(event) => event.preventDefault()}
          // Tapping clears the document selection, which schedules the watcher
          // to drop the target and unmount this button — a race the click would
          // lose. Acting on touchend runs before that, and preventDefault
          // suppresses the ghost click so it only fires once.
          onTouchEnd={(event) => {
            event.preventDefault();
            touchedRef.current = true;
            openComposer();
            window.setTimeout(() => { touchedRef.current = false; }, 400);
          }}
          onClick={() => {
            if (touchedRef.current) return;
            openComposer();
          }}
          className={ANNOTATION_TOOLBAR_BUTTON}
          style={{
            touchAction: 'manipulation',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          <MessageSquarePlus size={20} className="flex-shrink-0" />
          Add note
        </button>
        {onAsk && (
          <button
            type="button"
            data-annotation-ui="true"
            data-testid="annotation-ask-button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={openAsk}
            className={ANNOTATION_TOOLBAR_BUTTON}
            style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
          >
            <MessageCircleQuestion size={20} className="flex-shrink-0" />
            Ask
          </button>
        )}
        {renderDockedActions?.(target.messageId)}
      </div>,
      portalHost,
    );
  }

  // Small icon-only squares, so they cover as little of the line above the
  // selection as possible.
  const groupWidth = onAsk ? ANNOTATION_ICON_BUTTON_PX + 62 : ANNOTATION_ICON_BUTTON_PX;
  const left = computeAnchoredLeft(target.rect, groupWidth, viewport.width);
  const top = computeAnchoredTop(target.rect, ANNOTATION_ICON_BUTTON_PX, viewport.height, target.visibleTop);
  const square = {
    width: ANNOTATION_ICON_BUTTON_PX,
    height: ANNOTATION_ICON_BUTTON_PX,
    touchAction: 'manipulation' as const,
    WebkitTapHighlightColor: 'transparent',
  };

  if (!onAsk) {
    return createPortal(
      <button
        type="button"
        data-annotation-ui="true"
        data-testid="annotation-add-button"
        // Keep the selection alive: mousedown on a button would otherwise
        // collapse it before the click handler reads the captured target.
        onMouseDown={(event) => event.preventDefault()}
        onClick={openComposer}
        aria-label="Add note"
        className={`fixed z-50 ${ANNOTATION_ICON_BUTTON}`}
        style={{ ...square, top, left }}
      >
        <MessageSquarePlus size={14} className="flex-shrink-0" />
      </button>,
      portalHost,
    );
  }

  // With Ask: one joined bar, Add note's square then Ask with its word.
  return createPortal(
    <div data-annotation-ui="true" className="fixed z-50 flex rounded-sm border border-line bg-surface [&>button]:border-0 [&>button]:rounded-none [&>button+button]:border-l [&>button+button]:border-line" style={{ top, left }}>
      <button
        type="button"
        data-annotation-ui="true"
        data-testid="annotation-add-button"
        // Keep the selection alive: mousedown on a button would otherwise
        // collapse it before the click handler reads the captured target.
        onMouseDown={(event) => event.preventDefault()}
        onClick={openComposer}
        aria-label="Add note"
        className={ANNOTATION_ICON_BUTTON}
        style={square}
      >
        <MessageSquarePlus size={14} className="flex-shrink-0" />
      </button>
      <button
        type="button"
        data-annotation-ui="true"
        data-testid="annotation-ask-button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={openAsk}
        className={`${ANNOTATION_ICON_BUTTON} gap-1.5 px-2 text-xs font-medium`}
        style={{ ...square, width: undefined }}
      >
        <MessageCircleQuestion size={14} className="flex-shrink-0" />
        <span className="text-fg">Ask</span>
      </button>
    </div>,
    portalHost,
  );
}
