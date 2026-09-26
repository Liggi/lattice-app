/**
 * What a coordinator runs as when nobody says otherwise, from config alone,
 * so the create route and the new-session composer agree on it. The composer
 * used to show the general defaults while the route started a Claude
 * coordinator on the Claude CLI's own default and a Codex one at medium.
 *
 * A coordinator is a long conversation of short turns: it reads worker
 * reports, decides the next move and talks to the user. It does not implement,
 * so the deepest reasoning tier buys little and costs the wait on every
 * exchange, which made everything slow at a higher tier. Workers keep their
 * own routing, which is about the task in hand rather than the role.
 *
 * This applies at creation only, and stays that way now that the segment
 * records the effort a conversation is actually running at (codex-effort.ts):
 * an existing conversation resumes on its own setting, and a default applied
 * there would overwrite a choice the user had already made.
 */

import { DEFAULT_CODEX_MODEL_ID } from './codex-models.js';
import type { CoordinatorConfig } from '../types/config.js';

/** Overridable in config as `coordinator.reasoningEffort`. */
export const DEFAULT_COORDINATOR_EFFORT = 'medium';

export interface CoordinatorSettings {
  coordinator?: CoordinatorConfig;
  server?: { defaultModel?: string };
}

export interface CoordinatorCodexDefaults {
  model: string;
  reasoningEffort: string;
}

/** The configured coordinator provider: Codex unless `coordinator.provider` says Claude. */
export function coordinatorProviderFrom(settings: CoordinatorSettings | undefined): 'claude' | 'codex' {
  return settings?.coordinator?.provider === 'claude' ? 'claude' : 'codex';
}

/** Whether a provider's CLI is installed and signed in, as the CLI itself reports it. */
export type ProviderSignIn = 'signed-in' | 'signed-out' | 'not-installed' | 'unavailable';

const SIGN_IN_RANK: Record<ProviderSignIn, number> = { 'signed-in': 2, 'signed-out': 1, unavailable: 1, 'not-installed': 0 };

/**
 * The provider a coordinator starts on when nobody picks one: the configured
 * one, unless the other is further along (signed in where the configured one
 * is not, or installed where it is not). With neither signed in it stays on
 * the configured one, whose sign-in error then says what to do.
 */
export function coordinatorProviderFor(
  settings: CoordinatorSettings | undefined,
  signIn: Record<'claude' | 'codex', ProviderSignIn> | undefined,
): 'claude' | 'codex' {
  const preferred = coordinatorProviderFrom(settings);
  if (!signIn) return preferred;
  const other = preferred === 'claude' ? 'codex' : 'claude';
  return SIGN_IN_RANK[signIn[other]] > SIGN_IN_RANK[signIn[preferred]] ? other : preferred;
}

/**
 * The coordinator's Claude model: `coordinator.claudeModel`, else the
 * configured `server.defaultModel`, else undefined, which starts the Claude
 * CLI without --model on whatever the account defaults to. Not the
 * composer's Fable fallback: an account at its Fable limit got only a
 * limit message back from a coordinator pinned to it (2026-09-24).
 */
export function coordinatorClaudeModelFrom(settings: CoordinatorSettings | undefined): string | undefined {
  return settings?.coordinator?.claudeModel?.trim()
    || settings?.server?.defaultModel?.trim()
    || undefined;
}

/** The coordinator's Codex model and effort, from config or the defaults above. */
export function coordinatorCodexDefaultsFrom(settings: CoordinatorSettings | undefined): CoordinatorCodexDefaults {
  return {
    model: settings?.coordinator?.model?.trim() || DEFAULT_CODEX_MODEL_ID,
    reasoningEffort: settings?.coordinator?.reasoningEffort?.trim() || DEFAULT_COORDINATOR_EFFORT,
  };
}
