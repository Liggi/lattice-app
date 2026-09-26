import os from 'os';
import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('../../src/services/infrastructure/agent-skills.js', () => ({ codexSkillsRoot: () => os.tmpdir() }));

import { CodexAppServerClient } from '../../src/services/process/codex-app-server-client.js';

type ClientInternals = {
  child: {
    stdin: {
      writable: boolean;
      write(data: string, callback: (error?: Error | null) => void): void;
    };
  };
  handleLine(line: string): void;
  initializeProtocol(): Promise<void>;
};

describe('CodexAppServerClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts and resumes threads in full-access bypass mode', async () => {
    const client = new CodexAppServerClient('test-client', '/tmp');
    const ensureStarted = vi.spyOn(client, 'ensureStarted').mockResolvedValue(undefined);
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        thread: { id: 'thread-1' },
        model: 'gpt-5.5',
        modelProvider: 'openai',
        cwd: '/tmp/workspace',
        reasoningEffort: 'xhigh',
      })
      .mockResolvedValueOnce({
        thread: { id: 'thread-1' },
        model: 'gpt-5.5',
        modelProvider: 'openai',
        cwd: '/tmp/workspace',
        reasoningEffort: 'xhigh',
      });

    (client as unknown as { rpc: typeof rpc }).rpc = rpc;

    await client.startThread({
      cwd: '/tmp/workspace',
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
    });
    await client.resumeThread('thread-1', {
      cwd: '/tmp/workspace',
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
    });

    expect(ensureStarted).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(1, 'thread/start', {
      model: 'gpt-5.5',
      cwd: '/tmp/workspace',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      config: { model_reasoning_effort: 'xhigh' },
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'thread/resume', {
      threadId: 'thread-1',
      model: 'gpt-5.5',
      cwd: '/tmp/workspace',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      persistExtendedHistory: false,
      config: { model_reasoning_effort: 'xhigh' },
    });
  });

  it('acknowledges the initialize response, then gives Codex the Lattice skills root', async () => {
    const client = new CodexAppServerClient('test-client', '/tmp');
    const events: string[] = [];
    const write = vi.fn((data: string, callback: (error?: Error | null) => void) => {
      events.push(JSON.parse(data).method);
      callback();
    });
    (client as unknown as ClientInternals).child = {
      stdin: { writable: true, write },
    };
    const rpc = vi.fn(async (method: string) => {
      events.push(method);
      return {};
    });
    (client as unknown as { rpc: typeof rpc }).rpc = rpc;

    await (client as unknown as ClientInternals).initializeProtocol();

    expect(rpc).toHaveBeenCalledWith('initialize', {
      clientInfo: { name: 'lattice-app', version: '0.0.1' },
      capabilities: { experimentalApi: true },
    });
    expect(events).toEqual(['initialize', 'initialized', 'skills/extraRoots/set']);
    expect(rpc).toHaveBeenCalledWith('skills/extraRoots/set', { extraRoots: [os.tmpdir()] });
  });

  it('starts native thread compaction with the exact app-server request', async () => {
    const client = new CodexAppServerClient('test-client', '/tmp');
    vi.spyOn(client, 'ensureStarted').mockResolvedValue(undefined);
    const rpc = vi.fn().mockResolvedValue({});
    (client as unknown as { rpc: typeof rpc }).rpc = rpc;

    await client.startThreadCompaction('thread-compact-1');

    expect(rpc).toHaveBeenCalledWith('thread/compact/start', {
      threadId: 'thread-compact-1',
    });
  });

  it('distinguishes server requests from notifications and writes the JSON-RPC response', () => {
    const client = new CodexAppServerClient('test-client', '/tmp');
    const write = vi.fn((data: string, callback: (error?: Error | null) => void) => callback());
    (client as unknown as ClientInternals).child = {
      stdin: { writable: true, write },
    };
    const notificationHandler = vi.fn();
    const requestHandler = vi.fn((request: { id: string }, claim: () => void) => {
      claim();
      client.respondToServerRequest(request.id, { answers: {} });
    });
    client.on('notification', notificationHandler);
    client.on('request', requestHandler);

    (client as unknown as ClientInternals).handleLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 'server-1',
      method: 'item/tool/requestUserInput',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', questions: [] },
    }));

    expect(requestHandler).toHaveBeenCalledTimes(1);
    expect(notificationHandler).not.toHaveBeenCalled();
    expect(JSON.parse(write.mock.calls[0][0])).toEqual({
      jsonrpc: '2.0',
      id: 'server-1',
      result: { answers: {} },
    });
  });

  it('answers an unhandled server request with method-not-supported instead of hanging', () => {
    const client = new CodexAppServerClient('test-client', '/tmp');
    const write = vi.fn((data: string, callback: (error?: Error | null) => void) => callback());
    (client as unknown as ClientInternals).child = {
      stdin: { writable: true, write },
    };

    (client as unknown as ClientInternals).handleLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 77,
      method: 'unknown/thread/request',
      params: { threadId: 'thread-1' },
    }));

    expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({
      jsonrpc: '2.0',
      id: 77,
      error: { code: -32601 },
    });
  });
});
