/**
 * The provider a model id belongs to, so a session started with a model and
 * no provider runs where that model lives. A coordinator started with
 * `--model claude-sonnet-5-5` and no `--provider` used to go to the
 * configured coordinator provider, Codex, and fail its first turn.
 */

import type { Provider } from '../types/unified-messages.js';

const CLAUDE_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable', 'opusplan']);

/** The provider `model` belongs to, or undefined when the id does not say. */
export function providerForModel(model: string | null | undefined): Provider | undefined {
  const id = model?.trim().replace(/\[[^\]]*\]$/, '').toLowerCase();
  if (!id) return undefined;
  // opencode ids are its own `provider/model`, whatever model they name.
  if (id.includes('/')) return 'opencode';
  if (id.startsWith('claude-') || CLAUDE_ALIASES.has(id)) return 'claude';
  if (id.startsWith('gpt-') || id.startsWith('codex-') || /^o\d/.test(id)) return 'codex';
  return undefined;
}

/**
 * Why `model` cannot run on `provider`, or null if it can or the id does not
 * say. Refused rather than switched, so a caller that named both learns which
 * one is wrong.
 */
export function modelProviderMismatch(provider: string | undefined, model: string | null | undefined): string | null {
  const owner = providerForModel(model);
  if (!provider || !owner || owner === provider) return null;
  return `${model!.trim()} is a ${owner} model, but the provider is ${provider}: drop the provider or name a ${provider} model.`;
}
