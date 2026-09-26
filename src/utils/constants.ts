import path from 'path';
import os from 'os';

/**
 * Application branding constants
 * Change these to rebrand the entire application
 */
export const APP_NAME = 'lattice';

/**
 * Config directory: ~/.lattice-app/
 * Contains: config.json, session-info.db, the daemon socket, logs, and the
 * `bin/lattice` command agents dispatch with.
 *
 * Not ~/.lattice: that is the folder of the older npm release
 * (lattice-orchestrator), and people trying this one keep that installed and
 * running. Sharing it would let this server open and migrate the other's
 * database. Renaming the folder is this one line.
 *
 * Override with LATTICE_CONFIG_DIR env var for testing (prevents integration
 * tests from writing to the production database).
 */
export const CONFIG_DIR_NAME = '.lattice-app';
export const CONFIG_DIR = configDirNow();
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * The config dir as the environment says now. CONFIG_DIR is fixed at import;
 * code that tests re-point per file (vitest reuses forks) reads this instead.
 */
export function configDirNow(): string {
  return process.env.LATTICE_CONFIG_DIR || path.join(os.homedir(), CONFIG_DIR_NAME);
}
