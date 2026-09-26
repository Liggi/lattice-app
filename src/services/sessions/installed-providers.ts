import { existsSync } from 'fs';
import { delimiter, join } from 'path';
import { findUserClaudeExecutable } from '../process/claude-cli.js';

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
