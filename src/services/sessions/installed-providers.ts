import { existsSync } from 'fs';
import { delimiter, join } from 'path';
import { findUserClaudeExecutable } from '../process/claude-cli.js';
import { ConfigService } from '../infrastructure/config-service.js';
import { claudeEndpoints, modelReadsImages } from '../../constants/claude-endpoint.js';

export type AgentProvider = 'claude' | 'codex';

/**
 * The agent CLIs this server can start, found the way the sign-in status finds
 * them. Read per call, so installing one takes effect on the next coordinator
 * turn without a restart.
 */
export function installedProviders(pathValue: string | undefined = process.env.PATH): AgentProvider[] {
  const providers: AgentProvider[] = [];
  if (findUserClaudeExecutable(pathValue)) providers.push('claude');
  if ((pathValue ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, 'codex')))) providers.push('codex');
  return providers;
}

/** The models of the saved custom endpoints, each a Claude session can run on. */
export function claudeEndpointModels(): string[] {
  try {
    return claudeEndpoints(ConfigService.getInstance().getConfig()).map((endpoint) => endpoint.model);
  } catch {
    return [];
  }
}

/** Whether a session on `model` can be shown an image, from the saved endpoints; Claude's own models can. */
export function sessionReadsImages(model: string | null | undefined): boolean {
  try {
    return modelReadsImages(ConfigService.getInstance().getConfig(), model);
  } catch {
    return true;
  }
}
