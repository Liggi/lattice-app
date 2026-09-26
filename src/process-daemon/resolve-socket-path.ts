/**
 * One resolver for the daemon socket, shared by every entry point that picks
 * one: ensureDaemon (server startup, and the daemon it spawns) and the
 * standalone daemon in index.ts. The selection used to be duplicated, so
 * fixing it in one place would have left the other reachable.
 *
 * LATTICE_DAEMON_SOCKET is exported to every worker, and the SDK passes the
 * parent environment to children it spawns unless told otherwise, so a server
 * a worker launches receives it too. On 2026-09-21 a server pointed at a fresh
 * LATTICE_CONFIG_DIR still attached to the production daemon for exactly that
 * reason.
 *
 * An environment value carries no record of whether it was set deliberately or
 * arrived by inheritance, and nothing here tries to tell those apart. The
 * marker decides, not the environment:
 *
 *   valid marker declaring a socket  -> that socket, whether or not an
 *                                       override is present
 *   anything else                    -> <CONFIG_DIR>/daemon.sock
 *
 * The shared default is therefore never reached by an unmarked config dir. An
 * earlier version returned it whenever no override was set, which left a
 * fixture launched with a clean environment attached to the production daemon
 * anyway — the isolation failure this module exists to prevent, arrived at by
 * a different route.
 */

import path from 'path';
import { getHostIntegration } from '../services/infrastructure/host-integration.js';
import { CONFIG_DIR } from '../utils/constants.js';

export interface SocketPathDecision {
  socketPath: string;
  /** Set when an override was present but not claimed by a valid marker. */
  unboundOverride: string | null;
  /** Why the override was not honoured; null when there was nothing to reject. */
  reason: string | null;
}

export function decideSocketPath(): SocketPathDecision {
  const override = process.env.LATTICE_DAEMON_SOCKET || process.env.CUI_DAEMON_SOCKET || null;
  const authority = getHostIntegration();
  const privateSocket = path.join(CONFIG_DIR, 'daemon.sock');

  const declared = authority.manageClaudeSettings && authority.daemonSocket
    ? authority.daemonSocket
    : null;

  if (!declared) {
    return {
      socketPath: privateSocket,
      unboundOverride: override,
      reason: override
        ? (authority.deniedReason ?? 'host-integration marker declares no daemon socket')
        : null,
    };
  }

  // The marker is authoritative. An override that agrees with it is redundant
  // rather than load-bearing; one that disagrees is reported and ignored.
  const conflicting = override !== null
    && path.resolve(override) !== path.resolve(declared);

  return {
    socketPath: declared,
    unboundOverride: conflicting ? override : null,
    reason: conflicting ? 'host-integration marker declares a different daemon socket' : null,
  };
}
