/**
 * The heading above a section of the coordinator's right panel.
 *
 * The panel's sections used to be announced by 12px `fg-2` labels, which read
 * as really small and faded — nothing said where one section ended
 * and the next began. A heading here is 13px semibold in the
 * primary text colour, with a quiet icon naming the kind of section, and the
 * rule that separates the sections is drawn by `CoordinatorPanel`.
 *
 * Both sections use this so the two cannot drift apart; it exists for that
 * reason and not as a general-purpose heading.
 */

import React from 'react';
import type { LucideIcon } from 'lucide-react';

interface SectionHeadingProps {
  icon: LucideIcon;
  children: React.ReactNode;
}

export function SectionHeading({ icon: Icon, children }: SectionHeadingProps): JSX.Element {
  return (
    <div className="flex items-center gap-2 text-[13px] font-semibold leading-none text-fg">
      <Icon size={14} className="shrink-0 text-fg-3" aria-hidden />
      <span>{children}</span>
    </div>
  );
}
