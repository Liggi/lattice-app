import type { JSX } from 'react';

export type StateGlyphKind = 'todo' | 'progress' | 'waiting' | 'running' | 'done' | 'failed';

/**
 * Geometric state marks shared by the project panel, the sidebar and the
 * thread: an empty ring for work not started, a half-filled ring for the step
 * in hand, pause bars in a ring for work waiting on something outside, a
 * dashed ring for a running worker, a check for done and a cross for failed.
 * One colour each; only failure is rose.
 */
export function StateGlyph({ kind, size = 14, className }: { kind: StateGlyphKind; size?: number; className?: string }): JSX.Element {
  const ring = <circle cx={8} cy={8} r={6.25} fill="none" stroke="currentColor" strokeWidth={1.5} />;
  let body: JSX.Element;
  let tone = 'text-fg-3';
  switch (kind) {
    case 'todo':
      body = ring;
      break;
    case 'progress':
      tone = 'text-fg';
      body = <>{ring}<path d="M8 3.5 A4.5 4.5 0 0 1 8 12.5 Z" fill="currentColor" /></>;
      break;
    case 'waiting':
      body = (
        <>
          {ring}
          <line x1={6.4} y1={5.5} x2={6.4} y2={10.5} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
          <line x1={9.6} y1={5.5} x2={9.6} y2={10.5} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
        </>
      );
      break;
    case 'running':
      tone = 'text-fg-2';
      body = <><circle cx={8} cy={8} r={6.25} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="2 2.4" /><circle cx={8} cy={8} r={2.2} fill="currentColor" /></>;
      break;
    case 'done':
      body = <><circle cx={8} cy={8} r={7} fill="currentColor" fillOpacity={0.22} /><path d="M5.2 8.2 L7.2 10.1 L10.8 6" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" /></>;
      break;
    case 'failed':
      tone = 'text-rose-400';
      body = <><circle cx={8} cy={8} r={7} fill="currentColor" fillOpacity={0.18} /><path d="M5.8 5.8 L10.2 10.2 M10.2 5.8 L5.8 10.2" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" /></>;
      break;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={`shrink-0 ${className ?? tone}`} aria-hidden="true" data-glyph={kind}>
      {body}
    </svg>
  );
}

/** A keycap, for shortcuts that really work. */
export function Kbd({ children }: { children: string }): JSX.Element {
  return (
    <kbd className="inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-[5px] border border-line-2 px-1.5 font-sans text-[11px] leading-none text-fg-3">
      {children}
    </kbd>
  );
}

/** Whether this platform labels the modifier ⌘ rather than Ctrl. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}
