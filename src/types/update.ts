/** What a running Lattice knows about newer releases of itself; served at /api/update. */

export type InstallKind = 'source' | 'npm-global' | 'npx' | 'other';

export interface InstallInfo {
  kind: InstallKind;
  /** Whether the Update button can install and restart by itself. */
  canUpdate: boolean;
  /** What to run by hand when it can't; null for a source checkout. */
  command: string | null;
  /** Why it can't update itself, in a sentence for the user. */
  reason: string | null;
}

export interface ReleaseNote {
  version: string;
  name: string;
  body: string;
  url: string;
  publishedAt: string | null;
}

export interface UpdateStatus {
  current: string;
  /** A newer published version, or null when this is the latest (or unknown). */
  latest: string | null;
  checkedAt: string | null;
  install: InstallInfo;
  phase: 'idle' | 'installing' | 'restarting' | 'failed';
  error: { message: string; output: string } | null;
  preview: boolean;
}
