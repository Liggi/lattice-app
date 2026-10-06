import { describe, expect, it, vi } from 'vitest';
import { ChatGPTPlanClient, readPlanStream } from '../../src/services/infrastructure/chatgpt-plan-client.js';
import { CHATGPT_RESOURCE, type ChatGPTPlanAuth } from '../../src/services/infrastructure/chatgpt-plan-auth.js';

function stream(events: unknown[], extra = '') {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + extra, { headers: { 'Content-Type': 'text/event-stream' } });
}
const answer = (text: string, phase?: string) => ({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', role: 'assistant', status: 'completed', ...(phase ? { phase } : {}), content: [{ type: 'output_text', text, annotations: [] }] } });
// The ChatGPT backend leaves `output` empty on completion; the answer arrives only as response.output_item.done.
const completion = { type: 'response.completed', response: { status: 'completed', model: 'actual-discovered-model', usage: { input_tokens: 25, output_tokens: 8 }, output: [] } };
const delta = { type: 'response.output_text.delta', delta: 'Partial text should never count.' };

describe('completed plan inference', () => {
  it('reads fragmented UTF-8 and CRLF events through completion', async () => {
    const bytes = new TextEncoder().encode(`:comment\n\ndata: ${JSON.stringify(answer('Complete ✓'))}\r\n\r\ndata: ${JSON.stringify(completion)}\r\n\r\ndata: [DONE]\n\n`);
    const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }));
    expect(await readPlanStream(response)).toMatchObject({ text: 'Complete ✓', model: 'actual-discovered-model' });
  });
  it.each([
    [delta], [delta, { type: 'response.incomplete' }],
    [delta, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }],
    [answer('A complete result.'), completion, { type: 'error', code: 'late_failure' }],
    [answer('A complete result.'), completion, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_unavailable' } } }],
  ])('rejects partial, incomplete, and late-failed streams %j', async (...events) => {
    await expect(readPlanStream(stream(events))).rejects.toThrow();
  });
  it('reads the event sequence gpt-5.6-terra sent on 2026-09-30, whose completion carries no output', async () => {
    const item = answer('Lattice is ready.').item;
    const events = [{ type: 'response.created', response: { status: 'in_progress', output: [] } }, { type: 'response.in_progress', response: { status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', item: { ...item, status: 'in_progress', content: [] } }, { type: 'response.content_part.added', part: { type: 'output_text', text: '' } },
      ...['Lattice', ' is', ' ready', '.', ''].map((delta) => ({ type: 'response.output_text.delta', delta })), { type: 'response.output_text.done', text: 'Lattice is ready.' },
      { type: 'response.content_part.done', part: item.content[0] }, answer('Lattice is ready.'), completion];
    expect(await readPlanStream(stream(events))).toEqual({ text: 'Lattice is ready.', model: 'actual-discovered-model', inputTokens: 25, outputTokens: 8, cachedTokens: 0 });
  });
  it('skips commentary messages and non-message items', async () => {
    const events = [{ type: 'response.output_item.done', item: { type: 'reasoning', summary: [] } }, answer('Working on it.', 'commentary'), answer('Lattice is ready.', 'final_answer'), completion];
    expect(await readPlanStream(stream(events))).toMatchObject({ text: 'Lattice is ready.' });
  });
  it.each([
    ['response_text_empty', [completion]],
    ['response_model_missing', [answer('x'), { ...completion, response: { ...completion.response, model: undefined } }]],
    ['response_usage_missing', [answer('x'), { ...completion, response: { ...completion.response, usage: undefined } }]],
    ['response_not_completed', [answer('x'), { ...completion, response: { ...completion.response, status: 'in_progress' } }]],
  ])('names the failed completion field: %s', async (code, events) => {
    await expect(readPlanStream(stream(events))).rejects.toMatchObject({ code });
  });
  it('does not reinterpret malformed data containing private output as a logged diagnostic', async () => {
    await expect(readPlanStream(stream([], 'data: PRIVATE_PROMPT_SECRET\n\n'))).rejects.toThrow('invalid_json_payload');
  });
  it('preserves full instructions/history, omits unsupported fields, records actual model, discovers models and pauses new work at limits', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ client_id: 'oaiapp_fixture' })).toString('base64url')}.signature`;
    let paused = false;
    const auth = { accessToken: vi.fn(async () => { if (paused) throw new Error('paused'); return token; }), updateActive: vi.fn(async () => { paused = true; }) } as unknown as ChatGPTPlanAuth;
    const http = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/models') ? Response.json({ models: [{ slug: 'sol', display_name: 'Sol', visibility: 'list' }, { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' }] }) : stream([answer('A complete result.'), completion]));
    const client = new ChatGPTPlanClient(auth, http as typeof fetch);
    expect(await client.models()).toEqual([{ slug: 'sol', display_name: 'Sol' }]);
    const history = [{ role: 'user' as const, content: 'Whole context\n'.repeat(2000) }, { role: 'assistant' as const, content: 'First answer' }, { role: 'user' as const, content: 'Repair it' }];
    const result = await client.complete('sol', 'Whole instructions', history);
    expect(result.model).toBe('actual-discovered-model');
    const [url, options] = http.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe(`${CHATGPT_RESOURCE}/responses`);
    expect(JSON.parse(options.body as string)).toEqual({ model: 'sol', instructions: 'Whole instructions', input: history, store: false, stream: true });
    http.mockImplementationOnce(async () => stream([delta, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }]));
    await expect(client.complete('sol', '', history)).rejects.toThrow('subscription_sharing_usage_limit_exceeded');
    expect(auth.updateActive).toHaveBeenCalledWith({ paused: 'subscription_sharing_usage_limit_exceeded' }, 'oaiapp_fixture');
    const count = http.mock.calls.length;
    await expect(client.complete('sol', '', history)).rejects.toThrow('paused');
    expect(http).toHaveBeenCalledTimes(count);
  });
  it('keeps direct-admission status, body shape and request ID without exposing the body', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ client_id: 'oaiapp_fixture' })).toString('base64url')}.signature`;
    const client = new ChatGPTPlanClient({ accessToken: async () => token } as ChatGPTPlanAuth, vi.fn(async () => Response.json({ detail: 'Private upstream text' }, { status: 403, headers: { 'x-request-id': 'req-test' } })) as typeof fetch);
    await expect(client.complete('sol', '', [{ role: 'user', content: 'hello' }])).rejects.toMatchObject({ status: 403, bodyShape: 'detail', requestId: 'req-test', code: 'http_403' });
  });
});
