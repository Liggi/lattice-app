import Anthropic from '@anthropic-ai/sdk';
import type { BackgroundJob, BackgroundRoute } from '@/types/config.js';
import { modelEndpoints, endpointHost, type ClaudeEndpoint } from '../../constants/claude-endpoint.js';
import { anthropicClientFactory } from './anthropic-client-factory.js';
import { ConfigService } from './config-service.js';
import { chatgptPlanClient } from './chatgpt-plan-client.js';
import { PlanError } from './chatgpt-plan-auth.js';
import { createLogger } from './logger.js';
import { parseJson } from '../../utils/json.js';

const logger = createLogger('BackgroundTextClient');

/** 'endpoint': a server the user saved; Lattice cannot price it, so its calls are logged at no cost. */
export type BackgroundBillingKind = 'chatgpt-plan' | 'endpoint';
export type BackgroundMessage = Anthropic.Message & { billingKind?: BackgroundBillingKind; provider?: 'openai' | 'anthropic' };
export interface BackgroundTextClient { messages: { create(request: Anthropic.MessageCreateParamsNonStreaming): Promise<BackgroundMessage> } }

export function backgroundProvenance(response: Anthropic.Message, requestedModel: string): { model: string; billingKind?: BackgroundBillingKind; provider?: 'openai' | 'anthropic' } {
  const message = response as BackgroundMessage;
  return { model: response.model || requestedModel, ...(message.billingKind ? { billingKind: message.billingKind, provider: message.provider } : {}) };
}

/** The route `job` takes: its own if it has one, else the default. No job: the default. */
export function backgroundRoute(job?: BackgroundJob): BackgroundRoute {
  const config = ConfigService.getInstance().getConfig().backgroundInference;
  const own = job ? config?.jobs?.[job] : undefined;
  if (own) return own;
  if (!config) return { provider: 'anthropic-api' };
  // The default route's `model` is the ChatGPT plan's tested model, never an override for the other providers.
  return config.provider === 'endpoint' ? { provider: 'endpoint', endpointId: config.endpointId } : { provider: config.provider };
}

export function backgroundUsesPlan(job?: BackgroundJob): boolean {
  return backgroundRoute(job).provider === 'chatgpt-plan';
}

/** While the plan is paused and calls run on the user's stand-in: since when, and for which jobs. */
interface PlanStandIn { since: number; lastUsedAt: number; jobs: BackgroundJob[] }
let planStandIn: PlanStandIn | null = null;

export function planStandInStatus(): PlanStandIn | null {
  return planStandIn ? { ...planStandIn, jobs: [...planStandIn.jobs] } : null;
}

/** Test seam. */
export function __resetPlanStandInForTests(): void { planStandIn = null; }

function findEndpoint(endpointId: string | undefined): ClaudeEndpoint | null {
  return modelEndpoints(ConfigService.getInstance().getConfig()).find((endpoint) => endpoint.id === endpointId) ?? null;
}

function systemText(system: Anthropic.MessageCreateParamsNonStreaming['system']): string {
  return typeof system === 'string' ? system : (system ?? []).map((block) => block.text).join('\n');
}

function contentText(content: Anthropic.MessageParam['content'], unsupported: () => Error): string {
  return typeof content === 'string' ? content : content.map((block) => {
    if (block.type !== 'text') throw unsupported();
    return block.text;
  }).join('\n');
}

async function viaPlan(request: Anthropic.MessageCreateParamsNonStreaming): Promise<BackgroundMessage> {
  const selectedModel = ConfigService.getInstance().getConfig().backgroundInference?.model;
  if (!selectedModel) throw new PlanError('choose_discovered_model');
  if (request.tools?.length) throw new PlanError('unsupported_background_tools');
  const input = request.messages.map((message) => ({ role: message.role === 'system' ? 'developer' as const : message.role, content: contentText(message.content, () => new PlanError('unsupported_background_input')) }));
  const result = await chatgptPlanClient.complete(selectedModel, systemText(request.system), input, true);
  return { id: '', type: 'message', role: 'assistant', model: result.model, stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text: result.text, citations: null }],
    usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: result.cachedTokens },
    billingKind: 'chatgpt-plan', provider: 'openai' } as BackgroundMessage;
}

/** Reasoning models served raw (Qwen3, DeepSeek-R1) put their thinking in the answer between think tags. */
function withoutThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/** One Chat Completions call: Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, Groq, DeepSeek. */
async function viaOpenAICompatible(endpoint: ClaudeEndpoint, model: string, request: Anthropic.MessageCreateParamsNonStreaming): Promise<BackgroundMessage> {
  const host = endpointHost(endpoint.baseUrl);
  if (request.tools?.length) throw new Error(`This background call uses tools, which ${host} is not asked to run`);
  const unsupported = () => new Error(`This background call sends more than text, which ${host} is not asked to read`);
  const system = systemText(request.system);
  const messages = [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...request.messages.map((message) => ({ role: message.role, content: contentText(message.content, unsupported) })),
  ];
  const response = await fetch(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}) },
    body: JSON.stringify({ model, messages, max_tokens: request.max_tokens, ...(request.temperature !== undefined ? { temperature: request.temperature } : {}), stream: false }),
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await response.text();
  let body: { model?: string; error?: { message?: string } | string; choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  try { body = parseJson(raw) as typeof body; } catch { throw new Error(`${host} answered ${response.status} with something other than JSON`); }
  if (!response.ok) {
    const reason = typeof body.error === 'string' ? body.error : body.error?.message;
    throw new Error(`${host} answered ${response.status}${reason ? `: ${reason}` : ''}`);
  }
  const text = withoutThinking(body.choices?.[0]?.message?.content ?? '');
  if (!text) throw new Error(`${host} returned no text for ${model}`);
  return { id: '', type: 'message', role: 'assistant', model: body.model || model,
    stop_reason: body.choices?.[0]?.finish_reason === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text, citations: null }],
    usage: { input_tokens: body.usage?.prompt_tokens ?? 0, output_tokens: body.usage?.completion_tokens ?? 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    billingKind: 'endpoint', provider: 'openai' } as BackgroundMessage;
}

async function viaRoute(route: BackgroundRoute, request: Anthropic.MessageCreateParamsNonStreaming): Promise<BackgroundMessage> {
  if (route.provider === 'chatgpt-plan') return viaPlan(request);
  if (route.provider === 'anthropic-api') {
    const client = anthropicClientFactory.getClient();
    if (!client) throw new Error('The selected Anthropic API route is not configured.');
    return client.messages.create({ ...request, model: route.model || request.model });
  }
  const endpoint = findEndpoint(route.endpointId);
  if (!endpoint) throw new Error('The endpoint this background job uses has been removed. Choose another in Settings.');
  const model = route.model || endpoint.model;
  if (endpoint.protocol === 'openai') return viaOpenAICompatible(endpoint, model, request);
  const client = new Anthropic({ baseURL: endpoint.baseUrl, apiKey: endpoint.apiKey ?? 'not-needed', maxRetries: 0, timeout: 120_000 });
  const message = await client.messages.create({ ...request, model });
  return { ...message, billingKind: 'endpoint', provider: 'anthropic' };
}

function routeReady(route: BackgroundRoute): boolean {
  if (route.provider === 'chatgpt-plan') return true;
  if (route.provider === 'anthropic-api') return anthropicClientFactory.getClient() !== null;
  return findEndpoint(route.endpointId) !== null;
}

/**
 * Sends `request` the way `job` is routed. A plan call refused because the plan
 * is paused goes to the stand-in the user chose for that case, if any; the
 * stand-in is recorded so Settings can say it is in use.
 */
async function send(job: BackgroundJob | undefined, request: Anthropic.MessageCreateParamsNonStreaming): Promise<BackgroundMessage> {
  const route = backgroundRoute(job);
  if (route.provider !== 'chatgpt-plan') return viaRoute(route, request);
  try {
    const message = await viaRoute(route, request);
    if (planStandIn) logger.info('ChatGPT plan answering again; stand-in no longer used', { since: planStandIn.since });
    planStandIn = null;
    return message;
  } catch (error) {
    const standIn = ConfigService.getInstance().getConfig().backgroundInference?.whenPlanPaused;
    if (!(error instanceof PlanError) || error.status !== 429 || !standIn || standIn.provider === 'chatgpt-plan') throw error;
    const now = Date.now();
    if (!planStandIn) logger.info('ChatGPT plan paused; background calls use the stand-in', { standIn: standIn.provider, endpointId: standIn.endpointId, code: error.code });
    planStandIn = { since: planStandIn?.since ?? now, lastUsedAt: now, jobs: [...new Set([...(planStandIn?.jobs ?? []), ...(job ? [job] : [])])] };
    return viaRoute(standIn, request);
  }
}

export const backgroundTextClient = {
  /** A client for `job`'s route, or null when that route cannot be used. The route is read again on every call. */
  getClient(job?: BackgroundJob): BackgroundTextClient | null {
    if (!routeReady(backgroundRoute(job))) return null;
    return { messages: { create: (request) => send(job, request) } };
  },
  isConfigured(job?: BackgroundJob): boolean { return routeReady(backgroundRoute(job)); },
  /**
   * One tiny call along `route`, for the Settings test button. `model` is the
   * caller's model for an Anthropic API route that names none. Never stands in
   * for a paused plan.
   */
  async test(route: BackgroundRoute, model: string): Promise<{ model: string; text: string }> {
    if (!routeReady(route)) throw new Error('That route is not set up yet.');
    const message = await viaRoute(route, { model, max_tokens: 400, messages: [{ role: 'user', content: 'Reply with exactly: ready' }] });
    const text = message.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('').trim();
    return { model: message.model, text };
  },
};
