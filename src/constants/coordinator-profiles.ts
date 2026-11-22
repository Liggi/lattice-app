/**
 * Coordinator profiles: a named set saying which model fills each role on a
 * project (front, an optional chief of staff, and the workers front
 * dispatches), with a sentence on when each is used.
 *
 * A coordinator records the profile it was created on, and keeps it: the
 * preamble is rebuilt from that name at compaction, so a coordinator never
 * moves to another profile because the default changed. A coordinator with no
 * recorded profile (every one created before profiles existed) is on "opus",
 * whose routing is the fixed text Lattice has always given front.
 *
 * Profiles other than "opus" come from config (`coordinatorProfiles`), so a
 * new one is a config edit. "opus" is built in and cannot be redefined there,
 * so a missing or broken config can never change today's coordinators.
 */

/** The built-in profile: today's routing, and the one a coordinator without a recorded profile is on. */
export const BUILTIN_PROFILE = 'opus';

/** Claude Code's `--effort` levels. */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface ProfileModel {
  provider: 'claude' | 'codex' | 'antigravity';
  model: string;
  /** Claude `--effort` or Codex reasoning effort. Antigravity models carry their thinking level in the id. */
  effort?: string;
}

export interface ProfileWorkerRole extends ProfileModel {
  /** What front calls this kind of worker, e.g. "Opus". */
  label: string;
  /** When front dispatches it, written to front as a colleague would put it. `{user}` is the user's name. */
  when: string;
}

export interface CoordinatorProfile {
  /** One line on what the profile is for, shown when listing profiles. */
  description?: string;
  /** What front itself runs on. Absent: the coordinator defaults in config (coordinator-defaults.ts). */
  front?: ProfileModel;
  /** A standing session front consults on the harder calls. Absent: none. */
  chiefOfStaff?: ProfileModel & { label?: string };
  /** The workers front dispatches, in the order front should consider them. Absent: the built-in routing. */
  workers?: ProfileWorkerRole[];
}

export interface ResolvedProfile {
  name: string;
  profile: CoordinatorProfile;
}

export interface ProfileSettings {
  coordinatorProfiles?: Record<string, CoordinatorProfile>;
  coordinator?: { defaultProfile?: string };
}

const BUILTIN: CoordinatorProfile = {
  description: "Today's setup: front on the configured coordinator model, Opus workers, no chief of staff.",
};

/** Every profile name a coordinator can be created on: "opus" first, then the configured ones. */
export function profileNames(settings: ProfileSettings | undefined): string[] {
  const configured = Object.keys(settings?.coordinatorProfiles ?? {}).filter((name) => name !== BUILTIN_PROFILE);
  return [BUILTIN_PROFILE, ...configured];
}

/** The profile a name refers to, or null when there is none by that name. */
export function findProfile(name: string, settings: ProfileSettings | undefined): ResolvedProfile | null {
  if (name === BUILTIN_PROFILE) return { name, profile: BUILTIN };
  const profile = settings?.coordinatorProfiles?.[name];
  return profile && typeof profile === 'object' ? { name, profile } : null;
}

/**
 * The profile a coordinator is on, from the name recorded on it. Null (a
 * coordinator from before profiles) is "opus". A recorded name that has since
 * been removed from config falls back to "opus" too, named in `missing` so
 * the caller can say so rather than pretend.
 */
export function profileForRecorded(recorded: string | null | undefined, settings: ProfileSettings | undefined): ResolvedProfile & { missing?: string } {
  if (!recorded) return { name: BUILTIN_PROFILE, profile: BUILTIN };
  return findProfile(recorded, settings) ?? { name: BUILTIN_PROFILE, profile: BUILTIN, missing: recorded };
}

/** The profile a new coordinator starts on: the one asked for, else `coordinator.defaultProfile`, else "opus". */
export function profileForNewCoordinator(requested: string | undefined, settings: ProfileSettings | undefined): ResolvedProfile | { error: string } {
  const name = requested?.trim() || settings?.coordinator?.defaultProfile?.trim() || BUILTIN_PROFILE;
  return findProfile(name, settings)
    ?? { error: `no coordinator profile "${name}"; known: ${profileNames(settings).join(', ')}` };
}

/** Whether an effort value is one the provider takes; Antigravity takes none (its models carry it). */
export function effortProblem(provider: string, effort: string | undefined): string | null {
  if (!effort) return null;
  if (provider === 'claude') {
    return (CLAUDE_EFFORTS as readonly string[]).includes(effort)
      ? null
      : `Claude effort must be one of ${CLAUDE_EFFORTS.join(', ')}, got "${effort}"`;
  }
  if (provider === 'codex') return null;
  return `${provider} takes no effort setting${provider === 'antigravity' ? '; its model id carries the thinking level' : ''}`;
}
