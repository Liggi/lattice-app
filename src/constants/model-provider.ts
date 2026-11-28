/**
 * The provider a model id belongs to, so a session started with a model and
 * no provider runs where that model lives. A coordinator started with
 * `--model claude-sonnet-5-5` and no `--provider` used to go to the
 * configured coordinator provider, Codex, and fail its first turn.
 */

import type { Provider } from '../types/unified-messages.js';

const CLAUDE_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable', 'opusplan']);

/**
 * The provider `model` belongs to, or undefined when the id does not say.
 * `endpointModels` are the models of the saved Anthropic-API endpoints, which
 * run on Claude whatever their shape (`moonshotai/kimi-k3.1-pro` on a gateway).
 */
export function providerForModel(model: string | null | undefined, endpointModels: readonly string[] = []): Provider | undefined {
  const bare = model?.trim().replace(/\[[^\]]*\]$/, '');
  if (bare && endpointModels.includes(bare)) return 'claude';
  const id = bare?.toLowerCase();
  if (!id) return undefined;
  if (id.startsWith('agy:')) return 'antigravity';
  if (id.startsWith('inkling:')) return 'inkling';
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
export function modelProviderMismatch(provider: string | undefined, model: string | null | undefined, endpointModels: readonly string[] = []): string | null {
  const owner = providerForModel(model, endpointModels);
  if (!provider || !owner || owner === provider) return null;
  return `${model!.trim()} is a ${owner} model, but the provider is ${provider}: drop the provider or name a ${provider} model.`;
}
