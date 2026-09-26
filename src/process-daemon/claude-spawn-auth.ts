import fs from 'fs';
import { CONFIG_FILE } from '../utils/constants.js';
import { parseJson } from '../utils/json.js';
import { createLogger } from '../services/infrastructure/logger.js';

const logger = createLogger('ClaudeSpawnAuth');

export type ClaudeAuthMode = 'cli' | 'api-key';

/**
 * The credential a Claude conversation runs with, read from the config file
 * at the moment of spawning and applied to that child's environment only.
 *
 * It is read here, in the daemon, rather than sent over IPC: the key then
 * never appears in a spawn request, a persisted launch config or a log line,
 * and the daemon's own environment is untouched, so a key saved for summaries
 * cannot reach a conversation unless `server.claudeAuthMode` says so.
 */
export function claudeSpawnEnv(readConfig: () => string | null = readConfigFile): Record<string, string> {
  let mode: ClaudeAuthMode = 'cli';
  let apiKey: string | undefined;
  const raw = readConfig();
  if (raw) {
    try {
      const config = parseJson(raw) as { server?: { claudeAuthMode?: unknown }; anthropic?: { apiKey?: unknown } };
      if (config.server?.claudeAuthMode === 'api-key') mode = 'api-key';
      if (typeof config.anthropic?.apiKey === 'string' && config.anthropic.apiKey.trim()) apiKey = config.anthropic.apiKey.trim();
    } catch (error) {
      logger.warn('Config file unreadable; Claude runs on the CLI sign-in', { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (mode !== 'api-key') return {};
  if (!apiKey) {
    logger.warn('claudeAuthMode is api-key but no anthropic.apiKey is saved; Claude runs on the CLI sign-in');
    return {};
  }
  return { ANTHROPIC_API_KEY: apiKey };
}

function readConfigFile(): string | null {
  try {
    return fs.readFileSync(CONFIG_FILE, 'utf-8');
  } catch {
    return null;
  }
}
