import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PendingAnnotation } from '../../utils/annotations-format';
import { isInsideAnnotationUi } from '../../utils/annotation-selection';
import { computeKeyboardInset, shouldDockAnnotationUi } from '../../utils/annotation-viewport';
import { useCoarsePointer, useVisualViewport } from '../../hooks/useVisualViewport';
import { NoteEditor, computeAnchoredLeft, computeAnchoredTop } from './AnnotationSelectionLayer';
import { ANNOTATION_PANEL } from './annotation-styles';
import {
  ANNOTATION_ACTIVE_HIGHLIGHT_NAME,
  supportsHighlightApi,
  useAnnotationHighlights,
  type AnnotationHostResolver,
  type AnnotationSpanPlacement,
} from './useAnnotationHighlights';

const POPOVER_WIDTH_PX = 340;
const POPOVER_HEIGHT_PX = 200;
const VIEWPORT_MARGIN_PX = 12;

interface AnnotationSpanIconsProps {
  annotations: PendingAnnotation[];
  onUpdate: (id: string, note: string) => void;
  onRemove: (id: string) => void;
  /** Where quotes live in the DOM. Defaults to assistant messages. */
  resolveHost?: AnnotationHostResolver;
}

interface Editing {
  annotationId: string;
  /** Viewport rect of the span when the editor opened. */
  rect: { top: number; bottom: number; left: number; right: number };
}

/** The noted span, if any, whose line boxes contain the viewport point. */
export function hitTestPlacements(
  placements: AnnotationSpanPlacement[],
  x: number,
  y: number,
): AnnotationSpanPlacement | null {
  for (const placement of placements) {
    for (const rect of Array.from(placement.range.getClientRects())) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return placement;
    }
  }
  return null;
}

function spanRect(placement: AnnotationSpanPlacement): Editing['rect'] {
  const rect = placement.range.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
}

function setActiveHighlight(range: Range | null): void {
  if (!supportsHighlightApi()) return;
  try {
    if (range) CSS.highlights.set(ANNOTATION_ACTIVE_HIGHLIGHT_NAME, new Highlight(range));
    else CSS.highlights.delete(ANNOTATION_ACTIVE_HIGHLIGHT_NAME);
  } catch {
    // Decorative only.
  }
}

/**
 * Makes noted spans interactive. At rest a noted span shows only its highlight.
 * With a mouse, hovering it strengthens the tint and shows a hand cursor, and
 * clicking it opens the note for editing. On touch there is no hover: tapping
 * the span opens the same editor as a bottom sheet. A drag or long-press still selects text, since a click is only taken
 * when the selection is collapsed.
 */
export function AnnotationSpanIcons({
  annotations,
  onUpdate,
  onRemove,
  resolveHost,
}: AnnotationSpanIconsProps): JSX.Element | null {
  const placements = useAnnotationHighlights(annotations, resolveHost);
  const placementsRef = useRef(placements);
  placementsRef.current = placements;

  const [hovered, setHovered] = useState<AnnotationSpanPlacement | null>(null);
  const hoveredRef = useRef(hovered);
  hoveredRef.current = hovered;
  const [editing, setEditing] = useState<Editing | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** Host whose cursor was set to a hand, so it can be reset. */
  const cursorHostRef = useRef<HTMLElement | null>(null);

  const viewport = useVisualViewport();
  const coarsePointer = useCoarsePointer();
  const docked = shouldDockAnnotationUi(coarsePointer, viewport.width);

  const editingAnnotation = editing
    ? annotations.find((annotation) => annotation.id === editing.annotationId) ?? null
    : null;

  const setCursorHost = useCallback((host: HTMLElement | null) => {
    if (cursorHostRef.current === host) return;
    if (cursorHostRef.current) cursorHostRef.current.style.cursor = '';
    if (host) host.style.cursor = 'pointer';
    cursorHostRef.current = host;
  }, []);

  const openEditor = useCallback((placement: AnnotationSpanPlacement) => {
    const annotation = annotations.find((candidate) => candidate.id === placement.annotationId);
    if (!annotation) return;
    setDraft(annotation.note);
    setEditing({ annotationId: annotation.id, rect: spanRect(placement) });
    setHovered(null);
    setCursorHost(null);
  }, [annotations, setCursorHost]);
  const openEditorRef = useRef(openEditor);
  openEditorRef.current = openEditor;

  const closeEditor = useCallback(() => {
    setEditing(null);
    setDraft('');
  }, []);

  // Drop hover or editing state whose annotation is gone (sent, removed) or unmounted.
  useEffect(() => {
    if (hovered && !placements.some((p) => p.annotationId === hovered.annotationId)) {
      setHovered(null);
      setCursorHost(null);
    }
  }, [placements, hovered, setCursorHost]);
  useEffect(() => {
    if (editing && !editingAnnotation) closeEditor();
  }, [editing, editingAnnotation, closeEditor]);

  // Stronger tint on the hovered or edited span.
  useEffect(() => {
    const id = editing?.annotationId ?? hovered?.annotationId;
    const placement = id ? placements.find((p) => p.annotationId === id) : undefined;
    setActiveHighlight(placement?.range ?? null);
  }, [editing, hovered, placements]);
  useEffect(() => () => {
    setActiveHighlight(null);
    if (cursorHostRef.current) cursorHostRef.current.style.cursor = '';
  }, []);

  // Hover (mouse only): track which span is under the pointer.
  useEffect(() => {
    if (docked || typeof document === 'undefined') return;
    let frame = 0;
    let last: PointerEvent | null = null;
    const update = () => {
      frame = 0;
      const event = last;
      if (!event || editingRef.current) return;
      const target = event.target as Node | null;
      if (isInsideAnnotationUi(target)) return;
      const hit = hitTestPlacements(placementsRef.current, event.clientX, event.clientY);
      setCursorHost(hit?.host ?? null);
      if (hoveredRef.current?.annotationId !== hit?.annotationId) setHovered(hit);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      last = event;
      if (!frame) frame = requestAnimationFrame(update);
    };
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener('pointermove', onPointerMove);
    };
  }, [docked, setCursorHost]);

  // Click or tap on a noted span opens its note. A drag-select ends in a click
  // too, so only a collapsed selection counts.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (isInsideAnnotationUi(target)) return;
      if (target?.closest?.('a, button, input, textarea, [role="button"]')) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const hit = hitTestPlacements(placementsRef.current, event.clientX, event.clientY);
      if (hit) openEditorRef.current(hit);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  // Dismiss the editor on Escape or a press outside it.
  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeEditor();
      }
    };
    const onPointerDown = (event: Event) => {
      if (isInsideAnnotationUi(event.target as Node)) return;
      closeEditor();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [editing, closeEditor]);

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [editing]);

  const save = useCallback(() => {
    if (!editing || draft.trim() === '') return;
    onUpdate(editing.annotationId, draft);
    closeEditor();
  }, [editing, draft, onUpdate, closeEditor]);

  const remove = useCallback(() => {
    if (!editing) return;
    onRemove(editing.annotationId);
    closeEditor();
  }, [editing, onRemove, closeEditor]);

  if (typeof document === 'undefined') return null;

  let editorPanel: JSX.Element | null = null;
  if (editing && editingAnnotation) {
    const editor = (
      <NoteEditor
        quote={editingAnnotation.quote}
        note={draft}
        onNoteChange={setDraft}
        onSubmit={save}
        onCancel={closeEditor}
        onDelete={remove}
        inputRef={inputRef}
      />
    );
    const shared = {
      'data-annotation-ui': 'true',
      className: `fixed z-50 overflow-hidden ${ANNOTATION_PANEL}`,
    } as const;
    if (docked) {
      // Bottom sheet above the software keyboard, as when adding a note.
      const keyboardInset = computeKeyboardInset(viewport.layoutHeight, viewport);
      editorPanel = (
        <div
          {...shared}
          data-testid="annotation-edit-sheet"
          style={{
            left: VIEWPORT_MARGIN_PX,
            right: VIEWPORT_MARGIN_PX,
            bottom: keyboardInset + VIEWPORT_MARGIN_PX,
            touchAction: 'manipulation',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          {editor}
        </div>
      );
    } else {
      const width = Math.min(POPOVER_WIDTH_PX, viewport.width - 2 * VIEWPORT_MARGIN_PX);
      editorPanel = (
        <div
          {...shared}
          data-testid="annotation-edit-popover"
          style={{
            top: computeAnchoredTop(editing.rect, POPOVER_HEIGHT_PX, viewport.height),
            left: computeAnchoredLeft(editing.rect, width, viewport.width),
            width,
          }}
        >
          {editor}
        </div>
      );
    }
  }

  return editorPanel ? createPortal(editorPanel, document.body) : null;
}
