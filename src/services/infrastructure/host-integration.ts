/**
 * Host integration authority — who may write machine-wide Claude Code state.
 *
 * Lattice writes three things that live outside its config dir and are shared
 * by every Claude process on the machine: the PreToolUse and PermissionRequest
 * hooks in ~/.claude/settings.json, the toolPermissions allow-list in the same
 * file, and the ~/.claude/hooks/pre-compact-hook.sh script. Each carries the
 * writing server's own port, so the last server to write owns the whole fleet's
 * hook traffic.
 *
 * On 2026-09-21 a worker started a throwaway server on port 3099 with
 * LATTICE_CONFIG_DIR pointed at /tmp. That does not isolate any of the three:
 * ClaudeSettingsService resolves os.homedir() directly. The fixture repointed
 * the machine's hooks at itself, every live claude worker opened a socket to
 * 3099 to serve them, and the fixture's own cleanup -- `lsof -ti:3099 | xargs
 * kill`, which selects connected clients as well as the listener -- killed four
 * unrelated workers along with it.
 *
 * Why a marker file and not an environment variable. The obvious fix is a flag
 * the real launchers set. It does not hold: a server passes its environment to
 * its workers, and a worker that launches an ad-hoc server passes it on again,
 * so the flag arrives at exactly the process it was meant to exclude. That is
 * the same inheritance that defeated LATTICE_CONFIG_DIR here, and it is why
 * nothing in this decision reads the environment.
 *
 * The marker names the config dir it was issued for, and authority requires
 * that name to match the config dir it was found in. An inherited variable
 * cannot grant authority because no variable is consulted. A copied config dir
 * cannot either: the copy still names the original path. That self-reference is
 * the whole mechanism -- a bare `{ "manageClaudeSettings": true }` would travel
 * with any `cp -r` and grant the fixture everything.
 *
 * Creation is deliberately an operator action. A server that wrote its own
 * marker when it found none would restore the original hazard on first run.
 * Absent marker means no host writes, and a warning naming the file at
 * startup and on every conversation spawn -- both go through ensureHooks.
 * See docs/host-integration-marker.md.
 */

import fs from 'fs';
import path from 'path';
import { parseJson } from '../../utils/json.js';
import { CONFIG_DIR } from '../../utils/constants.js';


/**
 * Canonical filesystem identity, or nothing.
 *
 * path.resolve collapses `.` and `..` textually and knows nothing about
 * symlinks, so a marker naming a real path and a CONFIG_DIR reaching the same
 * directory through a link would compare unequal and authority would be
 * withheld from a legitimate instance. realpath resolves both to the same
 * inode-backed path.
 *
 * There is deliberately no lexical fallback. An earlier version returned
 * path.resolve when realpath threw, which quietly turned every failure to
 * establish identity — a dangling symlink, a deleted root, a permission error
 * on a parent — back into the textual comparison this exists to replace. If we
 * cannot say what directory a path names, we cannot say it is the one the
 * marker was issued for, and authority is withheld.
 */
function canonicalize(target: string): { path: string } | { error: string } {
  try {
    return { path: fs.realpathSync(path.resolve(target)) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const HOST_INTEGRATION_FILENAME = 'host-integration.json';

export interface HostIntegrationMarker {
  manageClaudeSettings?: boolean;
  configDir?: string;
  daemonSocket?: string;
}

export interface HostIntegrationAuthority {
  /** True when this process may write shared ~/.claude state. */
  manageClaudeSettings: boolean;
  /** The daemon socket this config dir owns, when the marker declares one. */
  daemonSocket: string | null;
  /** Absolute path of the marker consulted, for log and error messages. */
  markerPath: string;
  /** Why authority was withheld; null when granted. */
  deniedReason: string | null;
}

let cached: HostIntegrationAuthority | null = null;

export function hostIntegrationMarkerPath(configDir: string = CONFIG_DIR): string {
  return path.join(configDir, HOST_INTEGRATION_FILENAME);
}

export function resolveHostIntegration(
  configDir: string = CONFIG_DIR
): HostIntegrationAuthority {
  const markerPath = hostIntegrationMarkerPath(configDir);
  const deny = (deniedReason: string): HostIntegrationAuthority => ({
    manageClaudeSettings: false,
    daemonSocket: null,
    markerPath,
    deniedReason,
  });

  if (!fs.existsSync(markerPath)) {
    return deny(`no host-integration marker at ${markerPath}`);
  }

  let marker: HostIntegrationMarker;
  try {
    marker = parseJson(fs.readFileSync(markerPath, 'utf-8')) as HostIntegrationMarker;
  } catch (error) {
    return deny(
      `host-integration marker is unreadable: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // The self-reference check. A marker carried into a copied config dir still
  // names the dir it was issued for, so it grants nothing here.
  const declared = typeof marker.configDir === 'string' ? marker.configDir : '';
  if (!declared) {
    return deny(`host-integration marker declares no configDir`);
  }
  // Absolute only. A relative root is interpreted against whatever cwd the
  // process happens to have, so the same marker would grant authority from one
  // working directory and withhold it from another.
  if (!path.isAbsolute(declared)) {
    return deny(`host-integration marker declares a relative configDir: ${declared}`);
  }
  const declaredRoot = canonicalize(declared);
  if ('error' in declaredRoot) {
    return deny(`cannot establish identity of the marker's configDir: ${declaredRoot.error}`);
  }
  const effectiveRoot = canonicalize(configDir);
  if ('error' in effectiveRoot) {
    return deny(`cannot establish identity of the acting config dir: ${effectiveRoot.error}`);
  }
  if (declaredRoot.path !== effectiveRoot.path) {
    return deny(
      `host-integration marker was issued for ${declaredRoot.path}, not ${effectiveRoot.path}`
    );
  }

  if (marker.manageClaudeSettings !== true) {
    return deny('host-integration marker does not set manageClaudeSettings');
  }

  return {
    manageClaudeSettings: true,
    daemonSocket: typeof marker.daemonSocket === 'string' && marker.daemonSocket
      ? marker.daemonSocket
      : null,
    markerPath,
    deniedReason: null,
  };
}

export function getHostIntegration(): HostIntegrationAuthority {
  if (!cached) {
    cached = resolveHostIntegration();
  }
  return cached;
}

/** Test seam: forget the cached authority so a test can vary the marker. */
export function resetHostIntegrationCache(): void {
  cached = null;
}
