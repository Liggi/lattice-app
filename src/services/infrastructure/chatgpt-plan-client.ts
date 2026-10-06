import { createLogger } from './logger.js';
import { chatgptPlanAuth, CHATGPT_RESOURCE, ChatGPTPlanAuth, PlanError, planHttpJson, parsePlanJson } from './chatgpt-plan-auth.js';

const logger = createLogger('ChatGPTPlanClient');

export interface PlanModel { slug: string; display_name: string }
export interface PlanCompletion { text: string; model: string; inputTokens: number; outputTokens: number; cachedTokens: number; accountId?: string }

function streamError(error: { code?: unknown } | undefined): PlanError {
  const code = typeof error?.code === 'string' && /^[a-z0-9_]+$/.test(error.code) ? error.code : 'response_failed';
  return new PlanError(code, code === 'subscription_sharing_usage_limit_exceeded' ? 429 : 502);
}

type PlanMessage = { type: string; phase?: string; content?: Array<{ type: string; text?: string }> };

/** Event types in arrival order, with repeats collapsed to `type×n`: a content-free trace of the stream. */
function eventTrace(types: string[]): string[] {
  const runs: Array<[string, number]> = [];
  for (const type of types) { const last = runs.at(-1); if (last?.[0] === type) last[1]++; else runs.push([type, 1]); }
  return runs.map(([type, n]) => n > 1 ? `${type}×${n}` : type);
}

export async function readPlanStream(response: Response): Promise<PlanCompletion> {
  if (!response.body) throw new PlanError('empty_response_stream', 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let completed: PlanCompletion | undefined;
  let dataLines: string[] = [];
  const types: string[] = [];
  // The ChatGPT backend delivers output items only as response.output_item.done; response.completed carries an empty output.
  const messages: PlanMessage[] = [];
  const fail: (code: string | PlanError, facts: Record<string, unknown>) => never = (code, facts) => {
    const error = code instanceof PlanError ? code : new PlanError(code, 502);
    logger.warn('ChatGPT plan stream rejected', { code: error.code, events: eventTrace(types), ...facts });
    throw error;
  };
  const consumeEvent = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n'); dataLines = [];
    if (data === '[DONE]') return;
    const event = parsePlanJson(data) as { type: string; error?: { code?: unknown }; code?: unknown; item?: PlanMessage; response?: {
      status?: string; error?: { code?: unknown }; model?: string;
      usage?: { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens?: number } };
    } };
    types.push(typeof event.type === 'string' ? event.type : typeof event.type);
    if (event.type === 'response.failed' || event.type === 'error') fail(streamError(event.response?.error ?? event.error ?? event), {});
    if (event.type === 'response.incomplete') fail('response_incomplete', {});
    if (event.type === 'response.output_item.done' && event.item?.type === 'message') messages.push(event.item);
    if (event.type !== 'response.completed') return;
    if (completed) fail('duplicate_response_completion', {});
    const result = event.response;
    // Codex-style models may narrate in `commentary` messages before the answer; only the answer counts.
    const answers = messages.filter((message) => message.phase !== 'commentary');
    const text = answers.flatMap((message) => message.content ?? []).filter((part) => part.type === 'output_text').map((part) => part.text ?? '').join('\n');
    const facts = { status: result?.status, messageItems: messages.length, answerItems: answers.length, phases: messages.map((message) => message.phase ?? 'none'), usageKeys: Object.keys(result?.usage ?? {}) };
    if (result?.status !== 'completed') fail('response_not_completed', facts);
    if (!result.model) fail('response_model_missing', facts);
    if (!text.trim()) fail('response_text_empty', facts);
    if (!Number.isFinite(result.usage?.input_tokens) || !Number.isFinite(result.usage?.output_tokens)) fail('response_usage_missing', facts);
    completed = { text, model: result.model, inputTokens: result.usage!.input_tokens, outputTokens: result.usage!.output_tokens, cachedTokens: result.usage!.input_tokens_details?.cached_tokens ?? 0 };
  };
  const consumeLine = (line: string) => {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === '') consumeEvent();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) { consumeLine(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
    }
    buffer += decoder.decode();
    if (buffer) consumeLine(buffer);
    consumeEvent();
    if (!completed) fail('stream_ended_without_completion', { messageItems: messages.length });
    logger.info('ChatGPT plan stream completed', { model: completed.model, events: eventTrace(types) });
    return completed;
  } finally {
    await reader.cancel(); reader.releaseLock();
  }
}

export class ChatGPTPlanClient {
  constructor(private readonly auth: ChatGPTPlanAuth = chatgptPlanAuth, private readonly http: typeof fetch = fetch) {}

  private async admitted<T>(action: (token: string, clientId: string) => Promise<T>, verifiedModel?: string): Promise<T> {
    const token = await this.auth.accessToken(verifiedModel);
    const clientId = (parsePlanJson(Buffer.from(token.split('.')[1], 'base64url').toString()) as { client_id: string }).client_id;
    try { return await action(token, clientId); }
    catch (error) {
      if (error instanceof PlanError && error.code === 'subscription_sharing_usage_limit_exceeded') await this.auth.updateActive({ paused: error.code }, clientId);
      throw error;
    }
  }

  async models(): Promise<PlanModel[]> {
    return this.admitted(async (token) => {
      const body = await planHttpJson(await this.http(`${CHATGPT_RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) })) as { models?: Array<PlanModel & { visibility: string }> };
      if (!Array.isArray(body.models)) throw new PlanError('invalid_model_catalog', 502);
      return body.models.filter((model) => model.visibility === 'list' && typeof model.slug === 'string' && typeof model.display_name === 'string').map(({ slug, display_name }) => ({ slug, display_name }));
    });
  }

  async complete(model: string, instructions: string, input: Array<{ role: 'user' | 'assistant' | 'developer'; content: string }>, requireVerified = false): Promise<PlanCompletion> {
    if (!model) throw new PlanError('choose_discovered_model');
    return this.admitted(async (token, clientId) => {
      const response = await this.http(`${CHATGPT_RESOURCE}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, instructions, input, store: false, stream: true }), signal: AbortSignal.timeout(120000) });
      if (!response.ok) await planHttpJson(response);
      return { ...await readPlanStream(response), accountId: clientId };
    }, requireVerified ? model : undefined);
  }
}

export const chatgptPlanClient = new ChatGPTPlanClient();
