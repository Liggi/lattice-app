import fs from 'fs';
import path from 'path';
import { ConfigService } from './infrastructure/config-service.js';
import { CONFIG_DIR } from '../utils/constants.js';
import { parseJson } from '../utils/json.js';
import type { LatticeConfig, UserConfig } from '../types/config.js';

const DEFAULT_USER_NAME = 'the user';

let fileUserConfig: UserConfig | undefined;

/**
 * The `user` block of config.json. The server reads it through ConfigService;
 * a process that never initialises the service (the `lattice` CLI) reads the
 * same file directly.
 */
function userConfig(): UserConfig {
  try {
    return ConfigService.getInstance().getConfig().user ?? {};
  } catch {
    // Not initialised in this process: fall through to the file.
  }
  if (fileUserConfig === undefined) {
    try {
      const raw = fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8');
      fileUserConfig = (parseJson(raw) as Partial<LatticeConfig> | null)?.user ?? {};
    } catch {
      fileUserConfig = {};
    }
  }
  return fileUserConfig;
}

/** How agent instructions name the person using Lattice, from `user.name`. */
export function userName(): string {
  return userConfig().name?.trim() || DEFAULT_USER_NAME;
}

/** `userName()` for the start of a sentence. */
export function UserName(): string {
  const name = userName();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The user's project names, from `user.projects`, used as hints when summarising sessions. */
export function userProjects(): string[] {
  return (userConfig().projects ?? []).filter((name) => typeof name === 'string' && name.trim() !== '');
}

/** The user's own standing guidance for a role, from local settings; '' when unset. */
export function userGuidance(role: 'coordinator' | 'worker'): string {
  const config = userConfig();
  const text = role === 'coordinator' ? config.coordinatorGuidance : config.workerGuidance;
  return text?.trim() ?? '';
}
