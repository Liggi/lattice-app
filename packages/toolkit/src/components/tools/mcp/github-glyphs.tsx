import React from 'react';

/**
 * GitHub's pull-request state icons, redrawn from Octicons (MIT), and the state
 * colours GitHub uses for them. A PR's state is the first thing anyone looks for,
 * and it is exactly what the generic renderer buried.
 */

export type PrState = 'open' | 'draft' | 'merged' | 'closed';

export const PR_COLOR: Record<PrState, string> = {
  open: '#3FB950',
  draft: '#8B949E',
  merged: '#A371F7',
  closed: '#F85149',
};

const PATHS: Record<PrState, string> = {
  open: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
  merged: 'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z',
  closed: 'M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm1.28-9.53a.75.75 0 0 0-1.06-1.06L11.5 2.44l-.97-.97a.75.75 0 0 0-1.06 1.06l.97.97-.97.97a.75.75 0 1 0 1.06 1.06l.97-.97.97.97a.75.75 0 1 0 1.06-1.06l-.97-.97.97-.97Z',
  draft: 'M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm0 11a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0-9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 3a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z',
};

export function PrStateIcon({ state, size = 14 }: { state: PrState; size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={PR_COLOR[state]} aria-label={state} role="img">
      <path d={PATHS[state]} />
    </svg>
  );
}

/** GitHub review states, with the colours GitHub gives them. */
export const REVIEW_STATE: Record<string, { label: string; color: string }> = {
  APPROVED: { label: 'approved', color: '#3FB950' },
  CHANGES_REQUESTED: { label: 'changes requested', color: '#D29922' },
  COMMENTED: { label: 'commented', color: '#8B949E' },
  DISMISSED: { label: 'dismissed', color: '#8B949E' },
  PENDING: { label: 'pending', color: '#D29922' },
};

/** A branch name, styled the way GitHub renders refs. */
export function BranchChip({ name }: { name: string }): React.JSX.Element {
  return (
    <span
      className="inline-block rounded px-1.5 py-[1px] font-mono text-[11px] whitespace-nowrap"
      style={{ backgroundColor: '#388BFD26', color: '#58A6FF' }}
    >
      {name}
    </span>
  );
}
