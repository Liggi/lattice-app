/**
 * Which of a coordinator's profile roles its workers fill, for the project
 * panel: so the user can see whether a profile's exceptional roles (a chief
 * of staff, a Fable worker) have been brought in or only its usual workers.
 *
 * The chief of staff is the worker created with that role
 * (`worker_role = 'chief-of-staff'`). Every other worker is matched to the
 * first of the profile's worker roles with its provider and model; the first
 * role listed is the usual one and its workers carry no label. A worker that
 * matches no role (dispatched on a model the profile does not name) is in no
 * role.
 *
 * A consult is a message the coordinator sent its chief of staff, read from
 * its worker history: the first one, which started it, and every one after.
 */

import { BUILTIN_PROFILE, type ResolvedProfile } from '@/constants/coordinator-profiles.js';
import type { ProfileRoster, WorkerHistoryRow, WorkerState } from '@/types/worker-events.js';

export const CHIEF_OF_STAFF_LABEL = 'Chief of staff';

const CONSULT_TAGS: ReadonlySet<WorkerHistoryRow['tag']> = new Set(['dispatch', 'answer', 'relay']);

export interface RosterResult {
  roster: ProfileRoster | null;
  /** Each labelled worker's role, keyed by worker id. */
  roles: Map<string, { label: string; chiefOfStaff: boolean }>;
}

export function profileRoster(
  profile: ResolvedProfile,
  workers: ReadonlyArray<Pick<WorkerState, 'worker' | 'provider' | 'model'>>,
  workerRole: (worker: string) => string | null,
  history: ReadonlyArray<Pick<WorkerHistoryRow, 'worker' | 'tag'>> = [],
): RosterResult {
  const roles = new Map<string, { label: string; chiefOfStaff: boolean }>();
  if (profile.name === BUILTIN_PROFILE) return { roster: null, roles };

  const chief: string[] = [];
  const workerRoles = profile.profile.workers ?? [];
  const filled = workerRoles.map(() => [] as string[]);
  for (const worker of workers) {
    if (workerRole(worker.worker) === 'chief-of-staff') {
      chief.push(worker.worker);
      roles.set(worker.worker, { label: CHIEF_OF_STAFF_LABEL, chiefOfStaff: true });
      continue;
    }
    const index = workerRoles.findIndex((role) => role.provider === worker.provider && role.model === worker.model);
    if (index < 0) continue;
    filled[index].push(worker.worker);
    if (index > 0) roles.set(worker.worker, { label: workerRoles[index].label, chiefOfStaff: false });
  }

  return {
    roster: {
      name: profile.name,
      roles: [
        ...(profile.profile.chiefOfStaff ? [{
          label: CHIEF_OF_STAFF_LABEL,
          chiefOfStaff: true,
          workers: chief,
          consults: history.filter((row) => chief.includes(row.worker) && CONSULT_TAGS.has(row.tag)).length,
        }] : []),
        ...workerRoles.map((role, index) => ({ label: role.label, chiefOfStaff: false, workers: filled[index] })),
      ],
    },
    roles,
  };
}
