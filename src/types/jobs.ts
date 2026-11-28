/**
 * Unified job contract shared across core Lattice (local `lattice run` / `lattice job`
 * watchers), plugin job providers, the `/api/jobs` route, and
 * the `Running now` UI.
 *
 * Lifecycle states align with MCP Tasks (`working`, `waiting`, `completed`,
 * `failed`, `cancelled`) plus Lattice's explicit `starting` and `stalled` states
 * so every surface tells the truth without inventing ad-hoc status strings.
 */

export type JobLifecycleState =
  | 'starting'
  | 'working'
  | 'waiting'
  | 'stalled'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface JobProjectRef {
  /** Owning Lattice conversation id (project coordinator or standalone session). */
  id: string;
  /** Plain human name shown in the UI. */
  name: string;
  /** Whether the owning conversation is a project coordinator or standalone session. */
  kind?: 'project' | 'session';
}

export interface JobDetailViewRef {
  pluginId: string;
  view: string;
  payload?: unknown;
}

export interface JobStageStep {
  name: string;
  status: 'done' | 'active' | 'pending';
}

export interface JobRecord {
  /** Globally unique job id across providers, e.g. `local:<session>:<label>` or `ci-runner:<id>`. */
  id: string;
  /** Provider id: `'local'` for Lattice-watched/managed jobs, or a plugin id such as `'ci-runner'`. */
  provider: string;
  /** Plain-English provider label shown in filters and provenance (`Local`, `CI runner`). */
  providerLabel: string;
  /** Plain-English title of what the job is doing. */
  label: string;
  state: JobLifecycleState;
  /** Short plain-English reason when stalled, failed, cancelled, or waiting. */
  stateReason?: string | null;
  /** Owning Lattice conversation id, when started from or linked to one. */
  session?: string | null;
  /** Owning Lattice project or session name, when known. */
  project?: JobProjectRef | null;
  /** Count of completed items (0 while starting). */
  done: number;
  /** Total expected items, or null when indeterminate / stage-only. */
  total: number | null;
  /** Plain unit name (`items`, `people`, `examples`, `files`, `lines`, etc.). */
  unit?: string;
  /** Items cleanly skipped or filtered out (so `done < total` on exit 0 still reads as completed). */
  skipped?: number;
  /** Per-item errors encountered while running. */
  failedCount?: number;
  /** Current stage subtitle when multi-stage (e.g. `2 of 3 — Writing vectors`). */
  stage?: string | null;
  /** Optional ordered list of stages so the detail pane shows where you are and what comes next. */
  stages?: JobStageStep[];
  /** Latest status note from the job or provider. */
  message?: string | null;
  /** Unix ms when the job started. */
  startedAt: number;
  /** Unix ms when progress last moved. */
  movedAt: number;
  /** Unix ms when the job was last read or updated. */
  updatedAt: number;
  /** Unix ms when the job reached a terminal state; null/undefined while active. */
  endedAt?: number | null;
  /** Measured items per minute (null until pace is known). */
  ratePerMin?: number | null;
  /** Estimated completion time (Unix ms), or null when unknown. */
  etaAt?: number | null;
  /** True when `etaAt` is a typical-duration guess rather than measured from live pace. */
  etaGuess?: boolean;
  /** Plain-English description of how progress is measured. */
  provenance?: string | null;
  /** Command launched by `lattice run`, when applicable. */
  command?: string | null;
  /** OS process id for local jobs, when known. */
  pid?: number | null;
  /** Exact process exit code when ended by `lattice run`. */
  exitCode?: number | null;
  /** Last ~40 lines of stdout/stderr captured by `lattice run`. */
  logTail?: string[];
  /** True when Lattice can stop this job from the UI. */
  canStop?: boolean;
  /** External link (e.g. the provider's run page), when applicable. */
  externalUrl?: string | null;
  /** Optional plugin-provided detail panel rendered inside Running now's detail pane. */
  detailView?: JobDetailViewRef | null;
}

export interface JobProviderWarning {
  provider: string;
  providerLabel: string;
  message: string;
}

export interface JobsFeedResponse {
  jobs: JobRecord[];
  activeCount: number;
  stalledCount: number;
  failedCount: number;
  warnings: JobProviderWarning[];
  readAt: number;
}

export function isActiveJobState(state: JobLifecycleState): boolean {
  return state === 'starting' || state === 'working' || state === 'waiting' || state === 'stalled';
}
