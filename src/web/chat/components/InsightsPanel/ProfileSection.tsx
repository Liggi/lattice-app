/**
 * The coordinator's profile, for a coordinator not on the built-in one, as
 * the panel's last section: one row per role with how much it has been used,
 * archived workers included. It answers "is this project bringing in its
 * chief of staff and its Fable workers, or only the usual ones?", which
 * Running cannot: the chief of staff is in Running only while it advises,
 * and a worker leaves Running once it reports.
 *
 * The chief of staff counts the times the coordinator has consulted it, each
 * worker role how many workers have been dispatched in it. A role nobody has
 * used keeps its row at half opacity.
 */

import type { JSX } from 'react';
import { Section } from './NarrowPanel';
import type { ProfileRole, ProfileRoster } from '@/types/worker-events';

export function ProfileSection({ roster }: { roster: ProfileRoster }): JSX.Element {
  return (
    <Section title={`${roster.name} profile`} testId="panel-profile">
      {roster.roles.map((role) => <RoleRow key={role.label} role={role} />)}
    </Section>
  );
}

function RoleRow({ role }: { role: ProfileRole }): JSX.Element {
  const count = role.chiefOfStaff ? role.consults ?? 0 : role.workers.length;
  return (
    <div
      data-testid="profile-role"
      data-used={count > 0 || undefined}
      className={`flex w-full items-baseline justify-between gap-3 rounded-sm px-2 py-1 pl-[46px] text-[13px] leading-[1.45] ${count > 0 ? '' : 'opacity-50'}`}
    >
      <span className="min-w-0 break-words text-fg-2">{role.label} {role.chiefOfStaff ? 'consults' : 'workers'}</span>
      <span className="shrink-0 tabular-nums text-fg-3">{count}</span>
    </div>
  );
}
