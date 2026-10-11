/**
 * A pull request's or release's stage as one glyph that fills as it advances,
 * in the sidebar state icons' language (thread 35160): grey that brightens as
 * work gets closer to users, cyan only where something is in motion (checks
 * running, a deploy still to come, light running round the step's face),
 * rose only for failing checks, green only once it is live or published.
 * Closed is dim; merged with no deploy to check is whole but grey.
 *
 * The sessions' cube drawn as three solid faces, one per step (checks left,
 * review right, merge top), faint until the step is done. No wireframe, so it
 * never reads as a worker's cube, which is all edges. Live is the whole cube
 * sealed, its faces closed up with no gaps; a release keeps its lid lifted
 * until it is published.
 */

import type { CSSProperties, JSX } from 'react';
import type { ShipStage } from '@/services/sessions/project-shipping';
import '../shared/session-state-icon/session-state-icon.css';

export function ShipStateIcon({ stage, size = 18 }: { stage: ShipStage; size?: number }): JSX.Element {
  return (
    <svg className="ssi" width={size} height={size} viewBox="2 2 20 20" fill="none" aria-hidden="true">
      <Box stage={stage} />
    </svg>
  );
}

const anim = (value: string, extra: CSSProperties = {}): CSSProperties => ({ animation: value, ...extra });
const breathe = (lo: number, hi: number, period = 4): CSSProperties =>
  anim(`ssi-breathe ${period}s ease-in-out infinite`, { ['--lo' as string]: lo, ['--hi' as string]: hi, opacity: (lo + hi) / 2 });

// Box: the cube's three faces, each pulled in a little from its edges so
// they read as separate steps without any lines between them.

const TOP = 'M12 3.5 L19.4 7.75 L12 12 L4.6 7.75 Z';
const LEFT = 'M4.6 7.75 L12 12 L12 20.5 L4.6 16.25 Z';
const RIGHT = 'M12 12 L19.4 7.75 L19.4 16.25 L12 20.5 Z';
const BOTTOM = 'M4.6 16.25 L12 12 L19.4 16.25 L12 20.5 Z';
const OUTLINE = 'M12 3.5 L19.4 7.75 L19.4 16.25 L12 20.5 L4.6 16.25 L4.6 7.75 Z';
const EDGE = { strokeWidth: 1.3, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const };
const inset = (cx: number, cy: number, k = .88) => `translate(${cx} ${cy}) scale(${k}) translate(${-cx} ${-cy})`;
const FACES = {
  left: { d: LEFT, at: inset(8.3, 14.1), lit: .78 },
  right: { d: RIGHT, at: inset(15.7, 14.1), lit: .62 },
  top: { d: TOP, at: inset(12, 7.75), lit: .95 },
};
const UNLIT = .15;
const DONE = 'rgb(var(--color-emerald-rgb, 52 211 153))';

function Box({ stage }: { stage: ShipStage }): JSX.Element {
  type Face = keyof typeof FACES;
  const face = (name: Face, opacity: number, fill = 'currentColor', style?: CSSProperties) => (
    <path key={name} d={FACES[name].d} transform={FACES[name].at} fill={fill} fillOpacity={opacity} style={style} />
  );
  /** Steps done light their face; the rest stay faint. */
  const cube = (done: Face[]) => (['left', 'right', 'top'] as Face[]).map((name) => face(name, done.includes(name) ? FACES[name].lit : UNLIT));
  /** The step under way: its face glows cyan while light runs round its edge, as work runs round a working session's cube. */
  const busy = (name: Face) => (
    <g key={name} transform={FACES[name].at}>
      <path d={FACES[name].d} fill="var(--c)" style={breathe(.25, .55, 2.4)} />
      <path d={FACES[name].d} pathLength={100} stroke="var(--c)" strokeDasharray="34 66" {...EDGE}
        style={anim('ssi-trace 1.8s linear infinite')} />
    </g>
  );
  switch (stage) {
    case 'draft':
      return <path d={OUTLINE} stroke="currentColor" strokeOpacity={.75} strokeDasharray="1.6 1.9" {...EDGE} />;
    case 'checks-running':
      return <g>{busy('left')}{face('right', UNLIT)}{face('top', UNLIT)}</g>;
    case 'checks-failing':
      return <g>{face('left', .9, 'var(--r)')}{face('right', UNLIT)}{face('top', UNLIT)}</g>;
    case 'checks-passed':
      return <g>{cube(['left'])}</g>;
    case 'approved':
      return <g>{cube(['left', 'right'])}</g>;
    case 'merged':
      // Merged: the lid is the step under way until the deploy lands.
      return <g>{face('left', FACES.left.lit)}{face('right', FACES.right.lit)}{busy('top')}</g>;
    case 'live':
    case 'published':
      // Sealed: the faces close up with no gaps between them, in the success
      // green. Nothing left to happen.
      return (
        <g fill={DONE}>
          <path d={LEFT} fillOpacity={.6} /><path d={RIGHT} fillOpacity={.42} /><path d={TOP} fillOpacity={.8} />
        </g>
      );
    case 'merged-unchecked':
      // Whole but grey, short of Live's green: merged, deploy unknown.
      return <g>{cube(['left', 'right', 'top'])}</g>;
    case 'closed':
      // Flattened: only the floor of the box is left.
      return <path d={BOTTOM} stroke="currentColor" strokeOpacity={.45} {...EDGE} />;
    case 'branch':
      // Two walls and no lid: work that is not in a pull request yet.
      return <g>{face('left', .6)}{face('right', .45)}</g>;
    case 'unpublished':
      // Packed, with the lid lifted off it, ready to close.
      return <g>{face('left', FACES.left.lit)}{face('right', FACES.right.lit)}<g transform="translate(0 -3)">{face('top', FACES.top.lit)}</g></g>;
  }
}
