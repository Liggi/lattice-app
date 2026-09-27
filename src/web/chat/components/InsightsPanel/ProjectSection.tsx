/**
 * Purpose: the outcome the coordinator has noted for the project, last in its
 * right panel because it rarely changes (see `src/types/project-state.ts`).
 * Renders nothing until an outcome is noted.
 *
 * The panel's other project sections are the to-do list in
 * `StateOfPlaySection`. The Working on section that used to lead the panel
 * went with it (2026-09-27): the work the project is on is the top of In
 * progress, in the user's order.
 */

import React from 'react';
import type { ProjectState } from '@/types/project-state';
import { SectionHeading } from './SectionHeading';

export function ProjectPurpose({ project }: { project: ProjectState }): JSX.Element | null {
  if (!project.outcome) return null;
  return (
    <section data-testid="project-purpose">
      <SectionHeading>Purpose</SectionHeading>
      <div data-testid="project-outcome" className="px-2 text-[12.5px] leading-[1.5] text-fg-3 break-words">
        {project.outcome}
      </div>
    </section>
  );
}
