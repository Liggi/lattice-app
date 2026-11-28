import React, { type JSX, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Eye, EyeOff, MessageSquarePlus, X } from 'lucide-react';
import { parseJson } from '../../../../utils/json.js';
import { noteBoxFraction, type AgentImageNote } from '@/utils/gallery-block';
import { NoteMarks, NotesList, type Mark } from './NoteMarks';
import type { ImageBox } from '../../utils/annotations-format';
import { imagePath, useImageNotes } from './image-notes-context';
import {
  ANNOTATION_BUTTON_BASE,
  ANNOTATION_BUTTON_GHOST,
  ANNOTATION_BUTTON_PRIMARY,
  ANNOTATION_PANEL,
} from '../MessageAnnotations/annotation-styles';

const MAX_SCALE = 6;
const TAP_SLOP = 6;
const SWIPE_MIN = 60;
const PAD = 12;
/** Fit to width, and scroll, when fitting the whole image would show it under this share of that width. */
const TALL_RATIO = 0.6;
/** A drawn box smaller than this on screen, in px, is taken as a slip. */
const MIN_BOX = 10;

export interface ViewerImage {
  src: string;
  alt: string;
  /** The agent's notes on it, from a ```lattice-gallery block. */
  notes?: AgentImageNote[];
  /** The pixel size the agent measured its boxes in. */
  size?: { w: number; h: number };
}

/** Whether notes show on the image; one switch for every image, kept across opens. */
const SHOWN_KEY = 'lattice-gallery-notes-shown';
function readShown(): boolean {
  try { return localStorage.getItem(SHOWN_KEY) !== 'false'; } catch { return true; }
}

function readItem(a: HTMLElement): ViewerImage {
  const item: ViewerImage = { src: a.getAttribute('href')!, alt: a.dataset.imageAlt ?? '' };
  if (a.dataset.agentNotes) {
    // Written by ViewableImage from notes parseGalleryBlock already checked.
    const { notes, size } = parseJson(a.dataset.agentNotes) as { notes: AgentImageNote[]; size?: { w: number; h: number } };
    item.notes = notes;
    if (size) item.size = size;
  }
  return item;
}

type Size = { w: number; h: number };
type Point = { x: number; y: number };
/** The image's top-left corner in the stage, and its scale over the fitted size. */
type View = { s: number; x: number; y: number };

type Series = { items: ViewerImage[]; index: number; messageId?: string };

/** The images a tap pages through: every viewable image in the same message, in order. */
function seriesFor(anchor: HTMLElement): Series {
  const scope = anchor.closest<HTMLElement>('[data-message-id]');
  const messageId = scope?.dataset.messageId;
  const anchors = (scope ? [...scope.querySelectorAll<HTMLElement>('[data-viewable-image]')] : [anchor])
    .filter((a) => a.getAttribute('href'));
  const index = anchors.indexOf(anchor);
  const items = anchors.map(readItem);
  return index >= 0 ? { items, index, messageId } : { items: [readItem(anchor)], index: 0, messageId };
}

/**
 * A chat image that opens in the viewer when tapped, together with the other
 * images in its message. A modified click (Cmd/Ctrl/middle) still opens the
 * file in a new tab.
 */
// Global CSS draws links cyan and underlined; an image link, or an image that fails, should not look like one.
const PLAIN_LINK: React.CSSProperties = { textDecoration: 'none', color: 'inherit' };

export function ViewableImage({ src, alt, children, className, notes, size }: {
  src?: string;
  alt: string;
  children: React.ReactNode;
  className?: string;
  /** The agent's notes on the image, shown on it in the viewer. */
  notes?: AgentImageNote[];
  size?: { w: number; h: number };
}): JSX.Element {
  const [series, setSeries] = useState<Series | null>(null);
  const close = useCallback(() => setSeries(null), []);
  return (
    <>
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        style={PLAIN_LINK}
        data-viewable-image
        data-image-alt={alt}
        data-agent-notes={notes && notes.length > 0 ? JSON.stringify({ notes, ...(size ? { size } : {}) }) : undefined}
        onClick={(e) => {
          if (!src || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          setSeries(seriesFor(e.currentTarget));
        }}
      >
        {children}
      </a>
      {series && <ImageViewer items={series.items} start={series.index} messageId={series.messageId} onClose={close} />}
    </>
  );
}

/** The image's size before zooming: the whole image, or its full width when that would leave it too small to read. */
function fittedSize(natural: Size, stage: Size): { size: Size; tall: boolean } {
  const room = { w: Math.max(1, stage.w - 2 * PAD), h: Math.max(1, stage.h - 2 * PAD) };
  const byWidth = Math.min(1, room.w / natural.w);
  const whole = Math.min(byWidth, room.h / natural.h);
  const tall = whole < byWidth * TALL_RATIO;
  const k = tall ? byWidth : whole;
  return { size: { w: natural.w * k, h: natural.h * k }, tall };
}

/** Centres (or, with `top`, top-aligns) an axis the image fits on; otherwise keeps the image's edges from leaving the stage's. */
function clampAxis(pos: number, length: number, room: number, top = false): number {
  if (length <= room - 2 * PAD) return top ? PAD : (room - length) / 2;
  return Math.min(PAD, Math.max(room - PAD - length, pos));
}

/**
 * Images opened over the whole window, one at a time: fitted to the screen
 * (a tall one to its width, scrolled), zoomed by pinching, Ctrl-wheel or a
 * double tap, panned by dragging. More than one image adds a position, a
 * thumbnail strip, Previous and Next, the arrow keys and a sideways swipe.
 * The app's viewport turns off browser pinch-zoom, so the zoom is done here.
 * Closes on the Close button, Escape, or a tap outside the image.
 *
 * Where notes can be sent, Add note turns a drag into a box with a note on
 * it, which rides on the next message (image-notes-context.tsx). A drawn box
 * opens again on a tap, to change or delete its note.
 */
export function ImageViewer({ items, start = 0, messageId, onClose }: { items: ViewerImage[]; start?: number; messageId?: string; onClose: () => void }): React.ReactPortal {
  const count = items.length;
  const [index, setIndex] = useState(() => Math.min(Math.max(0, start), count - 1));
  const item = items[index];
  const go = useCallback((step: number) => setIndex((i) => Math.min(count - 1, Math.max(0, i + step))), [count]);

  const stage = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState<Size | null>(null);
  const [natural, setNatural] = useState<(Size & { src: string }) | null>(null);
  const fit = natural?.src === item.src && stageSize ? fittedSize(natural, stageSize) : null;
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const stageRef = useRef(stageSize);
  stageRef.current = stageSize;

  const clampView = useCallback((v: View): View => {
    const f = fitRef.current;
    const st = stageRef.current;
    if (!f || !st) return v;
    // On a phone the image sits under the header, with the notes list below it.
    return { s: v.s, x: clampAxis(v.x, f.size.w * v.s, st.w), y: clampAxis(v.y, f.size.h * v.s, st.h, st.w < 640) };
  }, []);

  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [swipe, setSwipeState] = useState(0);
  const swipeRef = useRef(0);
  const setSwipe = (dx: number) => { swipeRef.current = dx; setSwipeState(dx); };
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ view: View; mid: Point; dist: number; moved: boolean; onImage: boolean; axis: 'x' | 'y' | null } | null>(null);
  const lastTap = useRef(0);

  const notesApi = useImageNotes();
  const canNote = !!notesApi && !!messageId;
  const [marking, setMarking] = useState(false);
  const [drawing, setDrawingState] = useState<{ from: Point; to: Point } | null>(null);
  const drawingRef = useRef(drawing);
  // Pointer events can arrive before a re-render, so the ref is the source of truth for a drag in progress.
  const setDrawing = (d: { from: Point; to: Point } | null) => { drawingRef.current = d; setDrawingState(d); };
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [shown, setShownState] = useState(readShown);
  const setShown = (v: boolean) => {
    setShownState(v);
    try { localStorage.setItem(SHOWN_KEY, String(v)); } catch { /* private mode: the switch still works for this open */ }
  };
  const [draft, setDraft] = useState<{ box: ImageBox; noteId?: string; text: string } | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const notesOn = (src: string) => (notesApi?.notes ?? []).filter((n) => n.messageId === messageId && n.image?.src === src);
  const boxes = notesOn(item.src);
  const hasNotes = (it: ViewerImage) => (it.notes?.length ?? 0) > 0 || notesOn(it.src).length > 0;
  const anyNotes = items.some(hasNotes);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (draftRef.current) {
        if (e.key === 'Escape') setDraft(null);
        return;
      }
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose, go]);

  useLayoutEffect(() => {
    const el = stage.current!;
    // A resize keeps the zoom but places the image again: the notes list arriving under it shrinks the stage.
    const measure = () => {
      const size = { w: el.clientWidth, h: el.clientHeight };
      stageRef.current = size;
      setStageSize(size);
      setView((v) => clampView(v));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [clampView]);

  // Neighbours load ahead so paging is instant; a half-written note belongs to the image it was on.
  useEffect(() => {
    setDraft(null);
    setPinned(null);
    for (const i of [index - 1, index + 1]) {
      if (items[i]) new Image().src = items[i].src;
    }
  }, [index, items]);

  // Back to fitted, at the top, whenever the image or the stage changes.
  const fitKey = fit ? `${item.src}@${fit.size.w}x${fit.size.h}` : '';
  useLayoutEffect(() => {
    if (!fitKey) return;
    setView(clampView({ s: 1, x: 0, y: PAD }));
  }, [fitKey, clampView]);

  const thumbs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    thumbs.current[index]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [index]);

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = stage.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** A stage point as a fraction of the image's width and height. */
  const toImage = (p: Point): Point => {
    const f = fitRef.current!;
    const v = viewRef.current;
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    return { x: clamp((p.x - v.x) / (v.s * f.size.w)), y: clamp((p.y - v.y) / (v.s * f.size.h)) };
  };
  const boxOf = (a: Point, b: Point): ImageBox => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

  /** Scale to `s`, keeping the content under `from` (at view `v`) under `to`. */
  const zoomed = useCallback((v: View, s: number, from: Point, to: Point): View => {
    const next = Math.min(MAX_SCALE, Math.max(1, s));
    const k = next / v.s;
    return clampView({ s: next <= 1.01 ? 1 : next, x: to.x - k * (from.x - v.x), y: to.y - k * (from.y - v.y) });
  }, [clampView]);

  /** Whether a drag moves the image: it is zoomed, or taller than the stage. */
  const pans = (v: View) => {
    const f = fitRef.current;
    const st = stageRef.current;
    return !!f && !!st && (v.s > 1 || f.size.h > st.h - 2 * PAD);
  };

  const startGesture = (onImage: boolean) => {
    const pts = [...pointers.current.values()];
    const mid = pts.length > 1 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : pts[0];
    const dist = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    gesture.current = { view: viewRef.current, mid, dist, moved: gesture.current?.moved ?? false, onImage, axis: null };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-image-note-editor]')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size === 1) gesture.current = null;
    setSwipe(0);
    const target = e.target as HTMLElement;
    startGesture(gesture.current?.onImage ?? (target.tagName === 'IMG' || !!target.closest('[data-image-note-box]')));
    // A second finger turns a box being drawn into a pinch.
    if (pointers.current.size > 1) { setDrawing(null); return; }
    if (marking && fitRef.current && gesture.current?.onImage) {
      const at = toImage(local(e));
      setDrawing({ from: at, to: at });
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, local(e));
    const g = gesture.current;
    const pts = [...pointers.current.values()];
    if (pts.length > 1) {
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      g.moved = true;
      setSwipe(0);
      setView(zoomed(g.view, g.view.s * (dist / g.dist), g.mid, mid));
      return;
    }
    const dx = pts[0].x - g.mid.x;
    const dy = pts[0].y - g.mid.y;
    if (!g.moved && Math.hypot(dx, dy) > TAP_SLOP) {
      g.moved = true;
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (!g.moved) return;
    if (drawingRef.current) { setDrawing({ from: drawingRef.current.from, to: toImage(pts[0]) }); return; }
    if (count > 1 && g.view.s === 1 && g.axis === 'x') setSwipe(dx);
    else if (pans(g.view)) setView(clampView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy }));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (pointers.current.size > 0) { startGesture(g?.onImage ?? false); return; }
    gesture.current = null;
    const drawn = drawingRef.current;
    if (drawn) {
      setDrawing(null);
      const box = boxOf(drawn.from, drawn.to);
      const f = fitRef.current;
      const s = viewRef.current.s;
      if (f && box.w * f.size.w * s >= MIN_BOX && box.h * f.size.h * s >= MIN_BOX) setDraft({ box, text: '' });
      return;
    }
    const swiped = swipeRef.current;
    if (swiped) {
      if (Math.abs(swiped) > SWIPE_MIN) go(swiped < 0 ? 1 : -1);
      setSwipe(0);
      return;
    }
    if (!g || g.moved) return;
    const tapped = (e.target as HTMLElement).closest<HTMLElement>('[data-image-note-box]')?.dataset.noteId;
    const opened = tapped ? boxes.find((n) => n.id === tapped) : undefined;
    if (opened?.image) { setDraft({ box: opened.image.box, noteId: opened.id, text: opened.note }); return; }
    if (tapped) { setPinned((p) => (p === tapped ? null : tapped)); return; }
    if (pinned) { setPinned(null); return; }
    const now = Date.now();
    if (g.onImage && now - lastTap.current < 300) {
      lastTap.current = 0;
      const at = local(e);
      setView((v) => (v.s > 1 ? zoomed(v, 1, at, at) : zoomed(v, 2.5, at, at)));
      return;
    }
    lastTap.current = now;
    if (!g.onImage && viewRef.current.s === 1 && !draftRef.current) onClose();
  };

  const onWheel = (e: React.WheelEvent) => {
    if (fitRef.current?.tall && !e.ctrlKey) {
      setView((v) => clampView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      return;
    }
    const at = local(e);
    setView((v) => zoomed(v, v.s * Math.exp(-e.deltaY * 0.002), at, at));
  };

  /** Whether the image runs on past the top or bottom of the stage, shown as a fade on that edge. */
  const more = fit && stageSize
    ? { up: view.y < 0, down: view.y + fit.size.h * view.s > stageSize.h }
    : { up: false, down: false };

  const saveDraft = () => {
    const d = draftRef.current;
    const text = d?.text.trim();
    if (!d || !text || !notesApi || !messageId) return;
    if (d.noteId) notesApi.update(d.noteId, text);
    else {
      const path = imagePath(item.src);
      const label = item.alt || path?.split('/').pop() || 'image';
      notesApi.add({ messageId, src: item.src, path, label, box: d.box, note: text });
    }
    setDraft(null);
  };
  const deleteDraft = () => {
    if (draft?.noteId) notesApi?.remove(draft.noteId);
    setDraft(null);
  };

  /** Where a box sits in the stage, in px. */
  const onStage = (b: ImageBox) => fit && {
    left: view.x + b.x * fit.size.w * view.s,
    top: view.y + b.y * fit.size.h * view.s,
    right: view.x + (b.x + b.w) * fit.size.w * view.s,
    bottom: view.y + (b.y + b.h) * fit.size.h * view.s,
  };
  const narrow = (stageSize?.w ?? 0) < 640;
  // On a phone the stage is no taller than the image fitted to its width, so the notes follow straight under it.
  const phoneStageH = narrow && stageSize && natural?.src === item.src
    ? natural.h * Math.min(1, (stageSize.w - 2 * PAD) / natural.w) + 2 * PAD
    : undefined;
  const EDITOR_W = 300;
  const EDITOR_H = 150;
  const editorAt = (() => {
    const r = draft && onStage(draft.box);
    if (!r || !stageSize || narrow) return null;
    const below = r.bottom + 8 + EDITOR_H <= stageSize.h - PAD;
    return {
      left: Math.min(Math.max(PAD, r.left), stageSize.w - EDITOR_W - PAD),
      top: below ? r.bottom + 8 : Math.max(PAD, r.top - 8 - EDITOR_H),
    };
  })();
  /** The agent's notes on this image with a box that lands on it; the rest are about the whole image. */
  const agentMarks = (item.notes ?? []).map((n, i) => {
    const box = n.box && natural?.src === item.src ? noteBoxFraction(n.box, natural, item.size) : null;
    return { key: `agent-${i}`, text: n.text, box };
  });
  const wholeImageNotes = agentMarks.filter((m) => !m.box && natural?.src === item.src);
  const lit = pinned ?? hovered;
  const marks: Mark[] = !fit || !shown ? [] : [
    ...agentMarks.filter((m) => m.box).map((m) => ({
      key: m.key, kind: 'agent' as const, text: m.text, rect: onStage(m.box!)!, active: lit === m.key,
    })),
    ...boxes.map((n) => ({
      key: n.id, kind: 'you' as const, text: n.note, rect: onStage(n.image!.box)!, active: draft?.noteId === n.id || lit === n.id,
    })),
  ];
  /** Notes listed beside the image (under it on a phone): the whole-image ones first, then by position. */
  const listNotes = !shown ? [] : [
    ...wholeImageNotes.map((m) => ({ key: m.key, kind: 'agent' as const, text: m.text, whole: true })),
    ...[...marks].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
      .map((m) => ({ key: m.key, kind: m.kind, text: m.text, whole: false })),
  ];
  const pick = (key: string) => {
    const mine = boxes.find((n) => n.id === key);
    if (mine?.image && canNote) { setDraft({ box: mine.image.box, noteId: mine.id, text: mine.note }); return; }
    setPinned((p) => (p === key ? null : key));
    // A picked note's box comes into view when it is off the stage, as on a tall page.
    const r = marks.find((m) => m.key === key)?.rect;
    if (r && stageSize && (r.top < 0 || r.bottom > stageSize.h)) {
      setView((v) => clampView({ ...v, y: v.y + stageSize.h / 2 - (r.top + r.bottom) / 2 }));
    }
  };
  // A tapped box brings its entry into view in the list.
  useEffect(() => {
    if (pinned) document.querySelector(`[data-note-entry="${pinned}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [pinned]);
  const shownBox = drawing ? boxOf(drawing.from, drawing.to) : draft && !draft.noteId ? draft.box : null;

  const navButton = 'grid h-11 w-11 shrink-0 place-items-center rounded-full text-fg hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent';

  return createPortal(
    <div
      data-image-viewer
      role="dialog"
      aria-modal="true"
      aria-label={item.alt || 'Image'}
      className="fixed inset-0 z-[100] flex flex-col"
      style={{ background: '#000' }}
    >
      <div data-image-viewer-bar className="flex items-start gap-3 px-2 pt-[var(--app-safe-area-top)]">
        {count > 1 && (
          <span data-image-viewer-position className="shrink-0 pl-2 pt-[13px] font-mono text-[13px] tabular-nums text-fg-2">
            {index + 1} of {count}
          </span>
        )}
        <p data-image-viewer-caption className={`min-w-0 flex-1 py-[11px] text-[14px] font-medium sm:text-[15px] leading-snug text-fg ${count > 1 ? '' : 'pl-2'}`}>
          {item.alt}
        </p>
        {anyNotes && (
          <button
            type="button"
            data-image-viewer-notes-toggle
            aria-pressed={shown}
            aria-label={shown ? 'Hide notes' : 'Show notes'}
            title={shown ? 'Hide notes' : 'Show notes'}
            onClick={() => { setShown(!shown); setPinned(null); if (shown) { setMarking(false); setDraft(null); } }}
            className="flex h-11 shrink-0 items-center gap-1.5 rounded-md px-3 text-[15px] font-medium text-fg hover:bg-white/10"
          >
            {shown ? <Eye size={18} aria-hidden /> : <EyeOff size={18} aria-hidden />}
            <span className="hidden sm:inline">{shown ? 'Hide notes' : 'Show notes'}</span>
          </button>
        )}
        {canNote && (
          <button
            type="button"
            data-image-viewer-mark
            aria-pressed={marking}
            aria-label="Add note"
            onClick={() => { setMarking((m) => !m); setDraft(null); setShown(true); }}
            className={`flex h-11 shrink-0 items-center gap-1.5 rounded-md px-3 text-[15px] font-medium hover:bg-white/10 ${marking ? 'bg-white/10 text-accent' : 'text-fg'}`}
          >
            <MessageSquarePlus size={18} aria-hidden />
            <span className="hidden sm:inline">Add note</span>
          </button>
        )}
        <button
          type="button"
          data-image-viewer-close
          aria-label="Close"
          onClick={onClose}
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-md px-3 text-[15px] font-medium text-fg hover:bg-white/10"
        >
          <X size={18} aria-hidden />
          <span className="hidden sm:inline">Close</span>
        </button>
      </div>
      {/* The stage, and on a wide screen the notes beside it. */}
      <div className="flex min-h-0 flex-1" style={{ maxHeight: phoneStageH }}>
        <div
          ref={stage}
          className="relative min-w-0 flex-1 overflow-hidden"
          style={{ touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        >
          <div
            className="absolute left-0 top-0"
            style={{
              width: fit?.size.w,
              height: fit?.size.h,
              visibility: fit ? 'visible' : 'hidden',
              transformOrigin: '0 0',
              transform: `translate(${view.x + swipe}px, ${view.y}px) scale(${view.s})`,
              cursor: marking ? 'crosshair' : pans(view) ? 'grab' : 'zoom-in',
            }}
          >
            <img
              key={item.src}
              src={item.src}
              alt={item.alt}
              draggable={false}
              onLoad={(e) => setNatural({ src: item.src, w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 })}
              className="block h-full w-full max-w-none select-none"
            />
          </div>
          {stageSize && (
            <NoteMarks marks={marks} narrow={narrow} offsetX={swipe} onHover={setHovered} />
          )}
          {fit && shownBox && (() => {
            const r = onStage(shownBox)!;
            return (
              <div
                aria-hidden
                className="pointer-events-none absolute rounded-[3px] border-2 border-dashed border-accent bg-accent/10"
                style={{ left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top }}
              />
            );
          })()}
          {marking && !draft && !drawing && (
            <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
              <span className="rounded-md bg-surface/90 px-3 py-1.5 text-[13px] text-fg-2">Drag over the part you mean</span>
            </div>
          )}
          {draft && (
            <form
              data-image-note-editor
              onSubmit={(e) => { e.preventDefault(); saveDraft(); }}
              className={`absolute z-10 flex flex-col ${ANNOTATION_PANEL} ${narrow ? 'inset-x-2 bottom-2' : ''}`}
              style={editorAt ? { left: editorAt.left, top: editorAt.top, width: EDITOR_W } : undefined}
            >
              <textarea
                autoFocus
                value={draft.text}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveDraft(); } }}
                placeholder="What about this part?"
                rows={3}
                className="w-full resize-none bg-transparent px-3 pt-2.5 text-[14px] leading-snug text-fg outline-none placeholder:text-fg-3"
              />
              <div className="flex items-center gap-1 px-1.5 pb-1">
                {draft.noteId && (
                  <button type="button" onClick={deleteDraft} className={`${ANNOTATION_BUTTON_BASE} ${ANNOTATION_BUTTON_GHOST} px-2.5`}>Delete</button>
                )}
                <span className="flex-1" />
                <button type="button" onClick={() => setDraft(null)} className={`${ANNOTATION_BUTTON_BASE} ${ANNOTATION_BUTTON_GHOST} px-2.5`}>Cancel</button>
                <button type="submit" disabled={!draft.text.trim()} className={`${ANNOTATION_BUTTON_BASE} ${ANNOTATION_BUTTON_PRIMARY} px-2.5`}>
                  {draft.noteId ? 'Save' : 'Add note'}
                </button>
              </div>
            </form>
          )}
          {more.up && <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-black/70 to-transparent" />}
          {more.down && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-black/70 to-transparent" />}
        </div>
        {!narrow && listNotes.length > 0 && (
          <NotesList notes={listNotes} narrow={false} activeKey={lit} onHover={setHovered} onPick={pick} />
        )}
      </div>
      {narrow && listNotes.length > 0 && (
        <NotesList notes={listNotes} narrow activeKey={lit} onHover={setHovered} onPick={pick} />
      )}
      {count > 1 && (
        <div data-image-viewer-strip className="mt-auto flex justify-center px-1 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-2">
          <div className="flex min-w-0 max-w-full items-center gap-1 sm:gap-2">
            <button type="button" aria-label="Previous image" data-image-viewer-prev className={navButton} disabled={index === 0} onClick={() => go(-1)}>
              <ChevronLeft size={22} aria-hidden />
            </button>
            <div className="min-w-0 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
              <div className="flex w-max gap-1.5 p-1 sm:gap-2">
                {items.map((it, i) => (
                  <button
                    key={`${i}-${it.src}`}
                    ref={(el) => { thumbs.current[i] = el; }}
                    type="button"
                    aria-label={it.alt ? `Image ${i + 1}: ${it.alt}` : `Image ${i + 1}`}
                    aria-current={i === index || undefined}
                    data-image-viewer-thumb
                    onClick={() => setIndex(i)}
                    className={`group relative h-10 w-[50px] shrink-0 overflow-hidden rounded-[5px] sm:h-14 sm:w-[84px]`}
                  >
                    <img src={it.src} alt="" draggable={false} loading="lazy" className={`h-full w-full object-cover object-top transition-opacity ${i === index ? 'opacity-100' : 'opacity-35 group-hover:opacity-70'}`} />
                    {hasNotes(it) && <span aria-label="Has notes" className="absolute bottom-1 right-1 h-2 w-2 rounded-full bg-white ring-1 ring-black/60" />}
                  </button>
                ))}
              </div>
            </div>
            <button type="button" aria-label="Next image" data-image-viewer-next className={navButton} disabled={index === count - 1} onClick={() => go(1)}>
              <ChevronRight size={22} aria-hidden />
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
