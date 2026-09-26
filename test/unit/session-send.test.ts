import { afterEach, describe, expect, it, vi } from 'vitest';
import { compactSession, sendSessionMessage } from '../../src/cli/session-send.js';
import { parseVerbArgs, SESSION_VERBS_BY_NAME } from '../../src/cli/session-cli-spec.js';

afterEach(() => vi.unstubAllGlobals());

describe('session send', () => {
  it('parses a session id and preserves a multiline message', () => {
    const parsed = parseVerbArgs(SESSION_VERBS_BY_NAME.get('send')!, ['conv-test', '--message', 'First line\nSecond line', '--json']);
    expect(parsed.named.conv).toBe('conv-test');
    expect(parsed.flags.message).toBe('First line\nSecond line');
    expect(parsed.flags.json).toBe(true);
  });

  it('uses the composer endpoint and preserves message text and model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendSessionMessage({ host: '127.0.0.1', port: 3001, conversationId: 'conv-test', message: 'A "quote"\n$literal', model: 'test-model' });
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3001/api/harness/conv-test/send');
    expect(JSON.parse(request.body)).toEqual({ input: 'A "quote"\n$literal', model: 'test-model', origin: 'cli' });
    expect(result).toEqual({ ok: true, conversationId: 'conv-test' });
  });

  it('carries a coordinator sender, summary and passed-on flag', async () => {
    const parsed = parseVerbArgs(SESSION_VERBS_BY_NAME.get('send')!, ['conv-w', '--from', 'conv-c', '--summary', 'Backfill is out of scope', '--passed-on', '--message', 'The user says skip it']);
    expect(parsed.flags['passed-on']).toBe(true);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    await sendSessionMessage({ host: '127.0.0.1', port: 3001, conversationId: 'conv-w', message: 'The user says skip it', from: 'conv-c', summary: 'Backfill is out of scope', passedOn: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ input: 'The user says skip it', from: 'conv-c', summary: 'Backfill is out of scope', passedOn: true, origin: 'cli' });
  });

  it('asks the server to interrupt the current turn and passes the delivery receipt through', async () => {
    const parsed = parseVerbArgs(SESSION_VERBS_BY_NAME.get('send')!, ['conv-w', '--interrupt', '--message', 'Stop: wrong branch']);
    expect(parsed.flags.interrupt).toBe(true);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true,"delivery":"now"}'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendSessionMessage({ host: '127.0.0.1', port: 3001, conversationId: 'conv-w', message: 'Stop: wrong branch', interrupt: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ input: 'Stop: wrong branch', interrupt: true, origin: 'cli' });
    expect(result.delivery).toBe('now');
  });

  it('asks the server to hold the message for the end of the running turn', async () => {
    const parsed = parseVerbArgs(SESSION_VERBS_BY_NAME.get('send')!, ['conv-w', '--from', 'conv-c', '--after-turn', '--message', 'Next: the docs']);
    expect(parsed.flags['after-turn']).toBe(true);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true,"delivery":"after-turn","afterTurn":true}'));
    vi.stubGlobal('fetch', fetchMock);
    await sendSessionMessage({ host: '127.0.0.1', port: 3001, conversationId: 'conv-w', message: 'Next: the docs', from: 'conv-c', afterTurn: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ input: 'Next: the docs', from: 'conv-c', afterTurn: true, origin: 'cli' });
  });

  it('reports rejected sends without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('session missing', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendSessionMessage({ host: 'localhost', port: 3001, conversationId: 'conv-no', message: 'hello' })).rejects.toThrow('HTTP 404');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects empty input before sending', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendSessionMessage({ host: 'localhost', port: 3001, conversationId: 'conv-test', message: ' \n' })).rejects.toThrow('non-empty');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('session compact', () => {
  it('compacts through the composer\'s endpoint, refuses mid-turn without stopping anything, and send points to it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"ok":true}'))
      .mockResolvedValueOnce(new Response('{"error":"Cannot compact while session is working"}', { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(compactSession({ host: '127.0.0.1', port: 3001, conversationId: 'conv-w' })).resolves.toEqual({ ok: true, conversationId: 'conv-w' });
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:3001/api/harness/conv-w/compact');
    await expect(compactSession({ host: '127.0.0.1', port: 3001, conversationId: 'conv-w' }))
      .rejects.toThrow('conv-w was not compacted: Cannot compact while session is working. Nothing was stopped');
    await expect(sendSessionMessage({ host: '127.0.0.1', port: 3001, conversationId: 'conv-w', message: ' /compact\n', from: 'conv-c' }))
      .rejects.toThrow('use `session compact conv-w`');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
