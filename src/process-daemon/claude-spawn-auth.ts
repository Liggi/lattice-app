import fs from 'fs';
import { CONFIG_FILE } from '../utils/constants.js';
import { parseJson } from '../utils/json.js';
import { createLogger } from '../services/infrastructure/logger.js';
import { endpointForModel } from '../constants/claude-endpoint.js';

const logger = createLogger('ClaudeSpawnAuth');

export type ClaudeAuthMode = 'cli' | 'api-key';

/**
 * Stands in for a key when an endpoint takes none. Without some key the CLI
 * either refuses ("Not logged in") or sends the machine's claude.ai token to
 * the endpoint (both seen against a stub server, CLI 2.1.284).
 */
export const ENDPOINT_PLACEHOLDER_KEY = 'lattice-no-key';

/**
 * The environment a Claude conversation runs with, read from the config file
 * at the moment of spawning and applied to that child only.
 *
 * It is read here, in the daemon, rather than sent over IPC: a key then
 * never appears in a spawn request, a persisted launch config or a log line,
 * and the daemon's own environment is untouched, so a key saved for summaries
 * cannot reach a conversation unless `server.claudeAuthMode` says so.
 *
 * A model served by a saved endpoint points this one process at that server,
 * whatever the billing setting; every other conversation keeps the Claude
 * sign-in. Every model the CLI might pick — the main one, the opus/sonnet/haiku
 * aliases subagents name, and the small background model — becomes the
 * endpoint's, so nothing asks it for a Claude model it does not serve. An
 * undefined value removes an inherited variable.
 */
export function claudeSpawnEnv(model?: string, readConfig: () => string | null = readConfigFile): Record<string, string | undefined> {
  let config: unknown = null;
  const raw = readConfig();
  if (raw) {
    try {
      config = parseJson(raw);
    } catch (error) {
      logger.warn('Config file unreadable; Claude runs on the CLI sign-in', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  const endpoint = endpointForModel(config, model);
  if (endpoint) {
    return {
      ANTHROPIC_BASE_URL: endpoint.baseUrl,
      ANTHROPIC_AUTH_TOKEN: endpoint.apiKey ?? ENDPOINT_PLACEHOLDER_KEY,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_MODEL: endpoint.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: endpoint.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: endpoint.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: endpoint.model,
      ANTHROPIC_SMALL_FAST_MODEL: endpoint.model,
      CLAUDE_CODE_SUBAGENT_MODEL: endpoint.model,
      // Auto-compact works from this; unset, the CLI assumes 200k for a model it does not know.
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: endpoint.contextWindow ? String(endpoint.contextWindow) : undefined,
    };
  }

  const c = config as { server?: { claudeAuthMode?: unknown }; anthropic?: { apiKey?: unknown } } | null;
  if (c?.server?.claudeAuthMode !== 'api-key') return {};
  const apiKey = typeof c.anthropic?.apiKey === 'string' ? c.anthropic.apiKey.trim() : '';
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
