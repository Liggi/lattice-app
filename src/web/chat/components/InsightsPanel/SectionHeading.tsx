/**
 * The label above a section of the coordinator's right panel.
 *
 * It is the left sidebar's section label ("Projects", "Sessions"): small,
 * muted, no icon, no rule. The panel used to announce its sections with a
 * bold heading and an icon over a divider, and read as a different product
 * from the sidebar beside it (2026-09-27).
 */

import React from 'react';

export function SectionHeading({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="px-2 pb-1.5 text-xs font-medium text-fg-3">{children}</div>;
}
