import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

const MAX_SCALE = 6;
const TAP_SLOP = 6;

type View = { s: number; x: number; y: number };
const FIT: View = { s: 1, x: 0, y: 0 };

/**
 * A chat image opened over the whole window: fitted to the screen, zoomed by
 * pinching, the wheel or a double tap, panned by dragging once zoomed. The
 * app's viewport turns off browser pinch-zoom, so the zoom is done here.
 * Closes on the Close button, Escape, or a tap outside the image.
 */
/**
 * A chat image that opens in the viewer when tapped. A modified click
 * (Cmd/Ctrl/middle) still opens the file in a new tab.
 */
export function ViewableImage({ src, alt, children, className }: { src?: string; alt: string; children: React.ReactNode; className?: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        data-viewable-image
        onClick={(e) => {
          if (!src || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          setOpen(true);
        }}
      >
        {children}
      </a>
      {open && src && <ImageViewer src={src} alt={alt} onClose={close} />}
    </>
  );
}

export function ImageViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }): React.ReactPortal {
  const stage = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(FIT);
  const viewRef = useRef(view);
  viewRef.current = view;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ view: View; mid: { x: number; y: number }; dist: number; moved: boolean; onImage: boolean } | null>(null);
  const lastTap = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  const centre = () => {
    const r = stage.current!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  /** Scale to `s`, keeping the content under `from` (at view `v`) under `to`. */
  const zoomed = useCallback((v: View, s: number, from: { x: number; y: number }, to: { x: number; y: number }): View => {
    const next = Math.min(MAX_SCALE, Math.max(1, s));
    if (next <= 1.01) return FIT;
    const c = centre();
    const k = next / v.s;
    return { s: next, x: to.x - c.x - k * (from.x - c.x - v.x), y: to.y - c.y - k * (from.y - c.y - v.y) };
  }, []);

  const startGesture = (onImage: boolean) => {
    const pts = [...pointers.current.values()];
    const mid = pts.length > 1 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : pts[0];
    const dist = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    gesture.current = { view: viewRef.current, mid, dist, moved: gesture.current?.moved ?? false, onImage };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-image-viewer-bar]')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) gesture.current = null;
    startGesture(gesture.current?.onImage ?? (e.target as HTMLElement).tagName === 'IMG');
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const pts = [...pointers.current.values()];
    if (pts.length > 1) {
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      g.moved = true;
      setView(zoomed(g.view, g.view.s * (dist / g.dist), g.mid, mid));
      return;
    }
    const dx = pts[0].x - g.mid.x;
    const dy = pts[0].y - g.mid.y;
    if (Math.hypot(dx, dy) > TAP_SLOP) g.moved = true;
    if (g.moved && g.view.s > 1) setView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (pointers.current.size > 0) { startGesture(g?.onImage ?? false); return; }
    gesture.current = null;
    if (!g || g.moved) return;
    const now = Date.now();
    if (g.onImage && now - lastTap.current < 300) {
      lastTap.current = 0;
      const at = { x: e.clientX, y: e.clientY };
      setView((v) => (v.s > 1 ? FIT : zoomed(v, 2.5, at, at)));
      return;
    }
    lastTap.current = now;
    if (!g.onImage && viewRef.current.s === 1) onClose();
  };

  const onWheel = (e: React.WheelEvent) => {
    const at = { x: e.clientX, y: e.clientY };
    setView((v) => zoomed(v, v.s * Math.exp(-e.deltaY * 0.002), at, at));
  };

  return createPortal(
    <div
      data-image-viewer
      role="dialog"
      aria-modal="true"
      aria-label={alt || 'Image'}
      className="fixed inset-0 z-[100] flex flex-col"
      style={{ background: '#000' }}
    >
      <div data-image-viewer-bar className="flex justify-end px-2 pt-[env(safe-area-inset-top)]">
        <button
          type="button"
          data-image-viewer-close
          onClick={onClose}
          className="flex h-11 items-center gap-1.5 rounded-md px-3 text-[15px] font-medium text-fg hover:bg-white/10"
        >
          <X size={18} aria-hidden />
          Close
        </button>
      </div>
      <div
        ref={stage}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        style={{ touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="max-h-full max-w-full select-none object-contain"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, cursor: view.s > 1 ? 'grab' : 'zoom-in' }}
        />
      </div>
    </div>,
    document.body,
  );
}
