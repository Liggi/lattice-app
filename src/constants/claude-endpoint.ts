import { getClaudeModel } from './claude-models.js';

export interface ClaudeEndpoint {
  id: string;
  baseUrl: string;
  model: string;
  /** Absent in the browser, which never reads a saved key back. */
  apiKey?: string;
  /** Tokens the served model holds; absent means the CLI's 200k assumption. */
  contextWindow?: number;
}

export const MIN_CONTEXT_WINDOW = 16_000;
export const MAX_CONTEXT_WINDOW = 10_000_000;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The saved endpoints that can run a session: each needs a base URL and a
 * model. Takes the raw config file, the parsed config or the browser's copy.
 */
export function claudeEndpoints(config: unknown): ClaudeEndpoint[] {
  const list = (config as { claudeEndpoints?: unknown } | null | undefined)?.claudeEndpoints;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: Record<string, unknown> | null) => {
    const baseUrl = text(entry?.baseUrl);
    const model = text(entry?.model);
    if (!baseUrl || !model) return [];
    const apiKey = text(entry?.apiKey);
    const contextWindow = contextWindowProblem(entry?.contextWindow) ? undefined : entry?.contextWindow as number | undefined;
    return [{ id: text(entry?.id) ?? model, baseUrl, model, ...(apiKey ? { apiKey } : {}), ...(contextWindow ? { contextWindow } : {}) }];
  });
}

/** The endpoint serving `model`, or null when the model is Anthropic's. A `[1m]`-style suffix is ignored. */
export function endpointForModel(config: unknown, model: string | null | undefined): ClaudeEndpoint | null {
  const id = model?.trim().replace(/\[[^\]]*\]$/, '');
  if (!id) return null;
  return claudeEndpoints(config).find((endpoint) => endpoint.model === id) ?? null;
}

/** Why `model` cannot name an endpoint, or null if it can. */
export function endpointModelProblem(model: string, others: string[]): string | null {
  if (!model.trim()) return 'Model is required';
  if (getClaudeModel(model.trim())) return `${model.trim()} is a Claude model; name the model the server serves`;
  if (others.includes(model.trim())) return `Another endpoint already serves ${model.trim()}`;
  return null;
}

/** Why `value` cannot be an endpoint's context window, or null if it can (absent is fine). */
export function contextWindowProblem(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'Context window must be a whole number of tokens';
  if (value < MIN_CONTEXT_WINDOW) return `Context window must be at least ${MIN_CONTEXT_WINDOW.toLocaleString('en-US')} tokens`;
  if (value > MAX_CONTEXT_WINDOW) return `Context window must be at most ${MAX_CONTEXT_WINDOW.toLocaleString('en-US')} tokens`;
  return null;
}

/** "http://127.0.0.1:8080/v1" -> "127.0.0.1:8080", or the URL as typed if it does not parse. */
export function endpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** An endpoint as an entry in a model picker. */
export function endpointModelOption(endpoint: ClaudeEndpoint, isDefault = false): { id: string; label: string; description: string; isDefault: boolean } {
  return { id: endpoint.model, label: endpoint.model, description: `Served by ${endpointHost(endpoint.baseUrl)}`, isDefault };
}
