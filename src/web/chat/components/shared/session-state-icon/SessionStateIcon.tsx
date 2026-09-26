import type { CSSProperties, JSX } from 'react';
import type { SessionActivityKind, WorkingLevel } from '../../../utils/session-activity';
import './session-state-icon.css';

/** Projects draw as the logo's full lattice; sessions and workers as its cube. */
export type StateIconVariant = 'session' | 'project';

export interface StateIconState {
  kind: SessionActivityKind;
  level?: WorkingLevel;
  /** Needs you only: 0–1, brighter and a harder pulse when higher. Full when absent. */
  strength?: number;
}

interface SessionStateIconProps {
  state: StateIconState;
  variant: StateIconVariant;
  size?: number;
}

/** A sidebar row's state: what it is doing, drawn and animated in the icon slot. */
export function SessionStateIcon({ state, variant, size = 22 }: SessionStateIconProps): JSX.Element {
  const Draw = variant === 'project' ? Lattice : Cube;
  return (
    <svg className="ssi" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <Draw kind={state.kind} level={state.level ?? 1} strength={state.strength ?? 1} />
    </svg>
  );
}

interface DrawProps { kind: SessionActivityKind; level: WorkingLevel; strength: number }

/**
 * Needs you's brightness and pulse from its strength: at full it is solid and
 * pulses every 1.2s with a wide glow; at none it sits at 25% and pulses every
 * 3.4s with a faint one.
 */
function needsYouPulse(strength: number): { period: string; style: CSSProperties } {
  return {
    period: `${(3.4 - 2.2 * strength).toFixed(2)}s`,
    style: {
      opacity: 0.25 + 0.75 * strength,
      ['--glow' as string]: `${(0.5 + 2.5 * strength).toFixed(2)}px`,
      ['--glow-a' as string]: (0.2 + 0.75 * strength).toFixed(2),
      ['--lift' as string]: `${(-1 - 2 * strength).toFixed(2)}px`,
      ['--flash' as string]: (1.1 + 0.3 * strength).toFixed(2),
    },
  };
}

const anim = (value: string, extra: CSSProperties = {}): CSSProperties => ({ animation: value, ...extra });

// ---------------------------------------------------------------------------
// Cube: the lattice logo's isometric cube. Work runs light along its edges.
// ---------------------------------------------------------------------------

const CUBE_OUTLINE = 'M12 3.5 L19.4 7.75 L19.4 16.25 L12 20.5 L4.6 16.25 L4.6 7.75 Z';
const CUBE_INNER = 'M4.6 7.75 L12 12 L19.4 7.75 M12 12 L12 20.5';
const FACE_TOP = 'M12 3.5 L19.4 7.75 L12 12 L4.6 7.75 Z';
const FACE_LEFT = 'M4.6 7.75 L12 12 L12 20.5 L4.6 16.25 Z';
const FACE_RIGHT = 'M12 12 L19.4 7.75 L19.4 16.25 L12 20.5 Z';

function Cube({ kind, level, strength }: DrawProps): JSX.Element {
  const edge = { strokeWidth: 1.3, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const };
  switch (kind) {
    case 'idle':
      return <g stroke="currentColor" {...edge}><path d={CUBE_OUTLINE} /><path d={CUBE_INNER} /></g>;
    case 'sleeping':
      return (
        <g stroke="currentColor" {...edge} style={anim('ssi-breathe 5s ease-in-out infinite', { ['--lo' as string]: .4, ['--hi' as string]: .7 })}>
          <path d={FACE_TOP} fill="currentColor" fillOpacity={.18} />
          <path d={CUBE_OUTLINE} strokeDasharray="1.2 2.2" />
        </g>
      );
    case 'waiting':
      return (
        <g {...edge}>
          <path d={CUBE_OUTLINE} stroke="var(--c)" strokeOpacity={.5} />
          <path d={CUBE_INNER} stroke="var(--c)" strokeOpacity={.5} />
          <path d={FACE_TOP} fill="var(--c)" stroke="none"
            style={anim('ssi-breathe 3.2s ease-in-out infinite', { ['--lo' as string]: .08, ['--hi' as string]: .45 })} />
        </g>
      );
    case 'compacting':
      return (
        <g className="whole" style={anim('ssi-squeeze 1.5s ease-in-out infinite')} stroke="var(--v)" {...edge}>
          <path d={FACE_TOP} fill="var(--v)" fillOpacity={.25} stroke="none" />
          <path d={CUBE_OUTLINE} /><path d={CUBE_INNER} />
        </g>
      );
    case 'needs-you': {
      const { period, style } = needsYouPulse(strength);
      return (
        <g style={anim(`ssi-glow-a ${period} ease-in-out infinite`, style)} stroke="var(--a)" {...edge}>
          <path d={FACE_LEFT} fill="var(--a)" fillOpacity={.22} />
          <path d={FACE_RIGHT} fill="var(--a)" fillOpacity={.12} />
          <path d={FACE_TOP} fill="var(--a)" fillOpacity={.55} style={anim(`ssi-lid ${period} ease-in-out infinite`)} />
        </g>
      );
    }
    case 'failed':
      return (
        <g stroke="var(--r)" {...edge}>
          <path d={FACE_TOP} />
          <path d={FACE_LEFT} />
          <path d={FACE_RIGHT} transform="translate(1.6 1.8)" fill="var(--r)" fillOpacity={.15} />
        </g>
      );
    case 'working': {
      const speed = level === 3 ? .9 : level === 2 ? 1.3 : 1.9;
      return (
        <g
          className="whole"
          style={level === 3 ? anim(`ssi-throb ${speed * 2}s ease-in-out infinite, ssi-glow-c ${speed * 2}s ease-in-out infinite`) : undefined}
          {...edge}
        >
          {level >= 2 && <path d={FACE_TOP} fill="var(--c)" stroke="none" style={anim(`ssi-breathe ${speed * 2}s ease-in-out infinite`, { ['--lo' as string]: .08, ['--hi' as string]: .35 })} />}
          {level === 3 && <path d={FACE_LEFT} fill="var(--v)" stroke="none" style={anim(`ssi-breathe ${speed * 2}s ease-in-out ${speed * .66}s infinite`, { ['--lo' as string]: .08, ['--hi' as string]: .35 })} />}
          {level === 3 && <path d={FACE_RIGHT} fill="var(--a)" stroke="none" style={anim(`ssi-breathe ${speed * 2}s ease-in-out ${speed * 1.33}s infinite`, { ['--lo' as string]: .06, ['--hi' as string]: .3 })} />}
          <path d={CUBE_OUTLINE} stroke="var(--c)" strokeOpacity={.35} />
          <path d={CUBE_INNER} stroke="var(--c)" strokeOpacity={.35} />
          <path d={CUBE_OUTLINE} pathLength={100} stroke="var(--c)" strokeWidth={1.9} strokeDasharray="24 76"
            style={anim(`ssi-trace ${speed}s linear infinite`)} />
          {level >= 2 && <path d={CUBE_INNER} pathLength={100} stroke="var(--v)" strokeWidth={1.9} strokeDasharray="30 70"
            style={anim(`ssi-trace-rev ${speed * .9}s linear infinite`)} />}
          {level === 3 && <path d={CUBE_OUTLINE} pathLength={100} stroke="var(--a)" strokeWidth={1.9} strokeDasharray="16 84" strokeDashoffset={50}
            style={anim(`ssi-trace ${speed}s linear ${-speed / 2}s infinite`)} />}
        </g>
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Lattice: the logo's full 3×3×3 lattice, turned slightly off the isometric
// axis so no node hides behind another. Nearer nodes are larger and brighter.
// Work runs through it as a wave from back to front; more workers, more
// colours and a faster wave.
// ---------------------------------------------------------------------------

interface LatticeEdge { d: string; depth: number; key: string; outer: boolean }
interface LatticeNode { x: number; y: number; z: number; sx: number; sy: number; depth: number; key: string }

const LATTICE: { nodes: LatticeNode[]; edges: LatticeEdge[] } = (() => {
  const ry = (38 * Math.PI) / 180;
  const rx = (26 * Math.PI) / 180;
  const scale = 5.2;
  const raw = [-1, 0, 1].flatMap(x => [-1, 0, 1].flatMap(y => [-1, 0, 1].map(z => {
    const x1 = x * Math.cos(ry) + z * Math.sin(ry);
    const z1 = -x * Math.sin(ry) + z * Math.cos(ry);
    const y1 = y * Math.cos(rx) - z1 * Math.sin(rx);
    const d = y * Math.sin(rx) + z1 * Math.cos(rx);
    return { x, y, z, sx: 12 + x1 * scale, sy: 12 - y1 * scale, d, key: `${x}${y}${z}` };
  })));
  const min = Math.min(...raw.map(n => n.d));
  const max = Math.max(...raw.map(n => n.d));
  const nodes = raw
    .map(({ d, ...n }) => ({ ...n, depth: (d - min) / (max - min) }))
    .sort((a, b) => a.depth - b.depth);
  const byKey = new Map(nodes.map(n => [n.key, n]));
  const edges: LatticeEdge[] = [];
  for (const n of nodes) {
    for (const [dx, dy, dz] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
      const m = byKey.get(`${n.x + dx}${n.y + dy}${n.z + dz}`);
      if (m) {
        edges.push({
          d: `M${n.sx.toFixed(2)} ${n.sy.toFixed(2)} L${m.sx.toFixed(2)} ${m.sy.toFixed(2)}`,
          depth: (n.depth + m.depth) / 2,
          key: `${n.key}-${m.key}`,
          // On the lattice's outer frame: the two coordinates that do not
          // change along the edge are both at the boundary.
          outer: [n.x, n.y, n.z].filter((c, k) => [dx, dy, dz][k] === 0).every(c => Math.abs(c) === 1),
        });
      }
    }
  }
  edges.sort((a, b) => a.depth - b.depth);
  return { nodes, edges };
})();

// Node size and brightness by nearness, so the lattice reads as a solid.
const nodeRadius = (n: LatticeNode, base = 1) => base * (0.55 + 0.6 * n.depth);
const nodeOpacity = (n: LatticeNode) => 0.35 + 0.65 * n.depth;
const LAYER_COLOURS = ['var(--a)', 'var(--v)', 'var(--c)']; // bottom, middle, top: the logo's gradient

function Lattice({ kind, level, strength }: DrawProps): JSX.Element {
  const edges = (stroke: string, strength: number, skip?: (e: LatticeEdge) => boolean, width = 0.8) => (
    <g stroke={stroke} strokeWidth={width} strokeLinecap="round">
      {LATTICE.edges.map(e => (skip?.(e) ? null : (
        <path key={e.key} d={e.d} strokeOpacity={strength * (0.3 + 0.7 * e.depth)} />
      )))}
    </g>
  );
  const nodes = (
    fill: (n: LatticeNode) => string,
    style?: (n: LatticeNode) => CSSProperties | undefined,
    base = 1,
    only?: (n: LatticeNode) => boolean,
  ) => LATTICE.nodes.map(n => (only && !only(n) ? null : (
    <circle key={n.key} cx={n.sx} cy={n.sy} r={nodeRadius(n, base)} fill={fill(n)} fillOpacity={nodeOpacity(n)} style={style?.(n)} />
  )));

  switch (kind) {
    case 'idle':
      return <g>{edges('currentColor', .7)}{nodes(() => 'currentColor')}</g>;
    case 'sleeping':
      return (
        <g style={anim('ssi-breathe 5s ease-in-out infinite', { ['--lo' as string]: .4, ['--hi' as string]: .7 })}>
          {edges('currentColor', 1, e => !e.outer, 1.1)}
          {nodes(() => 'currentColor', undefined, 1, n => Math.abs(n.x) + Math.abs(n.y) + Math.abs(n.z) === 3)}
        </g>
      );
    case 'waiting':
      return (
        <g>
          {edges('var(--c)', .45)}
          {nodes(() => 'var(--c)', undefined, .85)}
          <circle cx={12} cy={12} r={2.4} fill="var(--c)"
            style={anim('ssi-breathe 3.2s ease-in-out infinite', { ['--lo' as string]: .15, ['--hi' as string]: .7 })} />
        </g>
      );
    case 'compacting':
      return (
        <g>
          {edges('var(--v)', .35)}
          {nodes(() => 'var(--v)', n => anim('ssi-in 1.5s ease-in-out infinite', {
            ['--dx' as string]: `${((12 - n.sx) * .6).toFixed(2)}px`,
            ['--dy' as string]: `${((12 - n.sy) * .6).toFixed(2)}px`,
          }), 1.15)}
        </g>
      );
    case 'needs-you': {
      const { period, style } = needsYouPulse(strength);
      return (
        <g style={anim(`ssi-glow-a ${period} ease-in-out infinite`, style)}>
          {edges('var(--a)', .8)}
          {nodes(() => 'var(--a)', n => anim(`ssi-flash ${period} ease-out ${((Math.abs(n.x) + Math.abs(n.y) + Math.abs(n.z)) * .1).toFixed(2)}s infinite`), 1.2)}
        </g>
      );
    }
    case 'failed':
      return (
        <g>
          {edges('var(--r)', .7, e => e.key.startsWith('1') || e.key.includes('-1'))}
          {nodes(() => 'var(--r)', undefined, 1, n => n.x !== 1)}
        </g>
      );
    case 'working': {
      const period = level === 3 ? .85 : level === 2 ? 1.2 : 1.7;
      const colour = (n: LatticeNode) =>
        level === 1 ? 'var(--c)' : level === 2 ? (n.y === 0 ? 'var(--v)' : 'var(--c)') : LAYER_COLOURS[n.y + 1];
      return (
        <g style={level === 3 ? anim(`ssi-glow-c ${period * 2}s ease-in-out infinite`) : undefined}>
          {edges('var(--c)', level === 1 ? .45 : .6)}
          {nodes(colour, n => anim(`ssi-flash ${period}s ease-out ${(n.depth * period * .7).toFixed(2)}s infinite`), 1.15)}
        </g>
      );
    }
  }
}
