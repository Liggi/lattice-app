import React from 'react';

/**
 * Linear's status and priority glyphs, redrawn as SVG.
 *
 * Linear's own colours arrive in the API payload (`state.color`, `labels[].color`),
 * so these take a colour prop rather than hardcoding a palette — a card tinted with
 * `#FC7840` is showing the workspace's real Triage colour, not an approximation.
 *
 * Linear's brand guidelines (linear.app/brand) restrict altering their *logo*; these
 * are UI status indicators drawn from the documented state machine, not brand marks.
 */

/** The `state.type` enum Linear returns on every issue. */
export type LinearStateType = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';

/** Fallbacks for workspaces or endpoints that return a state name without a colour. */
const DEFAULT_COLOR: Record<LinearStateType, string> = {
  triage: '#FC7840',
  backlog: '#BEC2C8',
  unstarted: '#E2E2E2',
  started: '#F2C94C',
  completed: '#5E6AD2',
  canceled: '#95A2B3',
};

const R = 6;
const CIRCUMFERENCE = 2 * Math.PI * 3;

export function LinearStateIcon({
  type,
  color,
  size = 14,
}: {
  type: LinearStateType;
  color?: string;
  size?: number;
}): React.JSX.Element {
  const c = color || DEFAULT_COLOR[type] || DEFAULT_COLOR.unstarted;

  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-label={type} role="img">
      {type === 'backlog' && (
        <circle cx="7" cy="7" r={R} stroke={c} strokeWidth="1.5" strokeDasharray="1.6 1.8" fill="none" />
      )}

      {type === 'unstarted' && <circle cx="7" cy="7" r={R} stroke={c} strokeWidth="1.5" fill="none" />}

      {/* Started shows a part-filled ring: an inner circle whose thick dashed stroke reads as a pie wedge. */}
      {type === 'started' && (
        <>
          <circle cx="7" cy="7" r={R} stroke={c} strokeWidth="1.5" fill="none" />
          <circle
            cx="7"
            cy="7"
            r="3"
            stroke={c}
            strokeWidth="6"
            fill="none"
            strokeDasharray={`${CIRCUMFERENCE * 0.5} ${CIRCUMFERENCE}`}
            transform="rotate(-90 7 7)"
          />
        </>
      )}

      {type === 'completed' && (
        <>
          <circle cx="7" cy="7" r="7" fill={c} />
          <path d="M4 7.2 6.1 9.3 10 5.2" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </>
      )}

      {type === 'canceled' && (
        <>
          <circle cx="7" cy="7" r="7" fill={c} />
          <path d="M4.6 4.6 9.4 9.4M9.4 4.6 4.6 9.4" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
        </>
      )}

      {type === 'triage' && (
        <>
          <circle cx="7" cy="7" r="7" fill={c} />
          <path d="M7 3.4v4.2" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
          <circle cx="7" cy="10.1" r="0.95" fill="#fff" />
        </>
      )}
    </svg>
  );
}

/** Linear priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
export const PRIORITY_NAME = ['No priority', 'Urgent', 'High', 'Medium', 'Low'] as const;

/**
 * Linear draws priority as three ascending bars, filled to the level — except Urgent,
 * which is a filled square with an exclamation.
 */
export function LinearPriorityIcon({ value, size = 14 }: { value: number; size?: number }): React.JSX.Element {
  if (value === 1) {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-label="Urgent" role="img">
        <rect x="1" y="1" width="12" height="12" rx="3" fill="#FC7840" />
        <path d="M7 3.6v4.1" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="7" cy="10.1" r="0.9" fill="#fff" />
      </svg>
    );
  }

  // Bars are lit when the priority is at least as high as that bar's rank.
  const lit = (rank: number): string => (value > 0 && value <= 4 && 5 - value >= rank ? '#6E7A8E' : '#3A3F49');

  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-label={PRIORITY_NAME[value] ?? 'No priority'} role="img">
      <rect x="1.5" y="8" width="3" height="4.5" rx="1" fill={lit(1)} />
      <rect x="5.5" y="5" width="3" height="7.5" rx="1" fill={lit(2)} />
      <rect x="9.5" y="2" width="3" height="10.5" rx="1" fill={lit(3)} />
    </svg>
  );
}

/** Linear's logomark. Used to identify the source of the card, unaltered. */
export function LinearMark({ size = 14, className }: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="currentColor" className={className} aria-label="Linear" role="img">
      <path d="M1.22541 61.5228c-.97401-1.6679-.9621-3.7358.02515-5.393L42.2113 1.7038c1.0762-1.81266 3.3714-2.41393 5.1357-1.34447 1.7643 1.06946 2.3512 3.34827 1.2749 5.16094L7.66132 59.946c-.98736 1.6629-3.29117 2.2133-4.96353 1.2006-.59502-.3603-1.06135-.8799-1.37738-1.4706-.0527-.0985-.10188-.1997-.1474-.3034-.0159-.0363-.03138-.0728-.04644-.1096Z" />
      <path d="M12.1816 77.934c-.7543-1.2904-.5323-2.9344.5671-3.9832l45.1186-43.0733c1.1466-1.0946 2.9483-1.0419 4.0275.1176 1.0793 1.1596 1.028 2.9791-.1186 4.0738L16.6576 78.1423c-1.1466 1.0946-2.9483 1.0419-4.0276-.1176-.1622-.1741-.2995-.3651-.4109-.5672-.0171-.031-.0337-.0623-.0497-.0939Z" />
      <path d="M22.9861 85.7189c-.5308-.9079-.2765-2.0785.576-2.6838l38.3729-27.2402c.8897-.6314 2.1128-.4117 2.734.491.6213.9028.4032 2.1398-.4866 2.7712L25.8095 86.2973c-.89.6314-2.1129.4117-2.734-.491-.0358-.052-.069-.1057-.0994-.161Z" />
      <path d="M32.4431 90.7801c-.3628-.6207-.0959-1.409.5883-1.7282l30.3399-14.1616c.7125-.3327 1.561-.0273 1.8977.6831.3367.7104.0327 1.5613-.6798 1.894l-30.34 14.1616c-.7124.3326-1.5609.0273-1.8976-.6831-.0326-.0687-.0599-.1396-.0818-.2132-.0057-.019-.011-.0381-.0158-.0574Z" />
      <path d="M42.0827 93.402c-.1652-.5006.0993-1.0424.5898-1.2147l23.4313-8.2326c.5116-.1797 1.0727.0908 1.2547.6039.182.513-.0892 1.0756-.6009 1.2553L43.326 93.9874c-.5117.1797-1.0727-.0908-1.2548-.6039-.0029-.0041-.0032-.0081-.0046-.0122l.0161.0307Z" />
    </svg>
  );
}

/** A label chip tinted with the colour Linear returned for it. */
export function LinearLabel({ name, color }: { name: string; color?: string }): React.JSX.Element {
  const c = color || '#8A8F98';
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-[1px] text-[11px] whitespace-nowrap"
      style={{ backgroundColor: `${c}1F`, color: c, border: `1px solid ${c}33` }}
    >
      <span className="inline-block rounded-full" style={{ width: 5, height: 5, backgroundColor: c }} />
      {name}
    </span>
  );
}
