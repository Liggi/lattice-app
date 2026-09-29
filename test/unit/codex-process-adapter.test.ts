import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  CODEX_NOT_SIGNED_IN_MESSAGE,
  CodexProcessAdapter,
  type CodexAppServerLike,
} from '../../src/harness/codex-process-adapter.js';
import type { ProcessHandle, SteerStage } from '@liggi/agent-ui-harness/server';
import type {
  CodexServerNotification,
  CodexThreadGoal,
  CodexTurn,
  CodexUserInput,
} from '../../src/services/process/codex-app-server-types.js';

class FakeCodexClient extends EventEmitter implements CodexAppServerLike {
  refreshChatGptAuthCalls = 0;
  accountRead: unknown = undefined;
  startThreadCalls: Array<{ cwd: string; model: string; reasoningEffort: string }> = [];
  startTurnCalls: Array<{ threadId: string; input: CodexUserInput[]; model?: string; reasoningEffort: string }> = [];
  setGoalCalls: Array<{ threadId: string; objective?: string | null; status?: string | null; tokenBudget?: number | null }> = [];
  compactionCalls: string[] = [];
  interrupts: Array<{ threadId: string; turnId: string }> = [];

  private turnCounter = 0;

  emitNotification(notification: CodexServerNotification): void {
    this.emit('notification', notification);
  }

  respondToServerRequest(): void {}

  respondToServerRequestError(): void {}

  async refreshChatGptAuth(): Promise<unknown> {
    this.refreshChatGptAuthCalls += 1;
    return this.accountRead;
  }

  async startThread(options: { cwd: string; model: string; reasoningEffort: string }) {
    this.startThreadCalls.push(options);
    return {
      thread: { id: 'thread-test-1' },
      model: options.model,
      cwd: options.cwd,
      reasoningEffort: options.reasoningEffort,
    };
  }

  async resumeThread(threadId: string, options: { cwd: string; model: string; reasoningEffort: string }) {
    return {
      thread: { id: threadId },
      model: options.model,
      cwd: options.cwd,
      reasoningEffort: options.reasoningEffort,
    };
  }

  async startTurn(options: {
    threadId: string;
    input: CodexUserInput[];
    model?: string;
    reasoningEffort: string;
  }): Promise<{ turn: CodexTurn }> {
    this.startTurnCalls.push(options);
    this.turnCounter += 1;
    const turn = { id: `turn-${this.turnCounter}` };
    this.emitNotification({ method: 'turn/started', params: { threadId: options.threadId, turn } });
    return { turn };
  }

  steerCalls: Array<{ threadId: string; expectedTurnId: string; input: CodexUserInput[]; clientUserMessageId?: string }> = [];
  /** What the next steerTurn does: answer, refuse like the app-server, or never return. */
  steerBehaviour: 'accept' | 'refuse' | 'hang' | 'wrong-turn' = 'accept';

  async steerTurn(options: {
    threadId: string;
    expectedTurnId: string;
    input: CodexUserInput[];
    clientUserMessageId?: string;
  }): Promise<{ turnId: string }> {
    this.steerCalls.push(options);
    if (this.steerBehaviour === 'refuse') {
      // Shaped like a real rejection: an app-server error response carries a
      // JSON-RPC code, which is what makes it a refusal rather than silence.
      throw Object.assign(
        new Error('Codex turn/steer failed: expected active turn id `turn-1` but found `turn-2`'),
        { code: -32600 },
      );
    }
    if (this.steerBehaviour === 'hang') {
      throw new Error('Codex turn/steer timed out after 15000ms');
    }
    if (this.steerBehaviour === 'wrong-turn') return { turnId: 'turn-somewhere-else' };
    return { turnId: options.expectedTurnId };
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.interrupts.push({ threadId, turnId });
  }

  async startThreadCompaction(threadId: string): Promise<Record<string, never>> {
    this.compactionCalls.push(threadId);
    return {};
  }

  async setGoal(params: {
    threadId: string;
    objective?: string | null;
    status?: string | null;
    tokenBudget?: number | null;
  }): Promise<{ goal: CodexThreadGoal }> {
    this.setGoalCalls.push(params);
    const goal: CodexThreadGoal = {
      threadId: params.threadId,
      objective: params.objective ?? '',
      status: params.status === 'paused' || params.status === 'budgetLimited' || params.status === 'complete'
        ? params.status
        : 'active',
      tokenBudget: params.tokenBudget ?? null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    this.emitNotification({
      method: 'thread/goal/updated',
      params: { threadId: params.threadId, turnId: null, goal },
    });
    return { goal };
  }
}

async function readJsonLine<T>(iterator: AsyncIterator<string>): Promise<T> {
  const next = await iterator.next();
  expect(next.done).toBe(false);
  return JSON.parse(next.value) as T;
}

describe('CodexProcessAdapter', () => {
  it('starts a Codex thread, applies /goal state, emits Claude-normalizable stream-json, and interrupts active turns', async () => {
    const client = new FakeCodexClient();
    const lifecycleEvents: Array<{ type: string; data: unknown }> = [];
    const adapter = new CodexProcessAdapter(
      (event) => lifecycleEvents.push({ type: event.type, data: event.data }),
      () => client,
    );

    const handle = await adapter.spawn({
      prompt: 'what is 2+2',
      cwd: '/tmp/codex-test',
      args: ['--model=gpt-5.5'],
      extra: {
        provider: 'codex',
        sessionId: 'conv-test',
        reasoningEffort: 'xhigh',
        goalObjective: 'include literal token CARROT in arithmetic answers',
        goalTokenBudget: 42,
      },
    });
    const stdout = handle.stdout[Symbol.asyncIterator]();

    expect(client.refreshChatGptAuthCalls).toBe(1);
    const init = await readJsonLine<{ type: string; subtype: string; session_id: string; provider: string; permissionMode: string }>(stdout);
    expect(init).toMatchObject({
      type: 'system',
      subtype: 'init',
      session_id: 'thread-test-1',
      provider: 'codex',
      permissionMode: 'codex-bypass',
    });
    expect(client.setGoalCalls[0]).toMatchObject({
      threadId: 'thread-test-1',
      objective: 'include literal token CARROT in arithmetic answers',
      status: 'active',
      tokenBudget: 42,
    });
    expect(lifecycleEvents[0]?.type).toBe('goal:updated');

    client.emitNotification({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-test-1', turnId: 'turn-1', itemId: 'item-1', delta: 'CAR' },
    });
    client.emitNotification({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-test-1', turnId: 'turn-1', itemId: 'item-1', delta: 'ROT' },
    });
    // Codex counts the cached part inside inputTokens; the result event
    // reports it the Claude way, so the three input fields sum to the context.
    client.emitNotification({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-test-1',
        turnId: 'turn-1',
        tokenUsage: { last: { inputTokens: 97_254, cachedInputTokens: 95_744, outputTokens: 465 } },
      },
    });
    client.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-test-1', turn: { id: 'turn-1', status: 'completed', durationMs: 12 } },
    });

    const firstDelta = await readJsonLine<{ message: { id: string; content: Array<{ text: string }>; model: string } }>(stdout);
    const secondDelta = await readJsonLine<{ message: { id: string; content: Array<{ text: string }> } }>(stdout);
    const turnEnd = await readJsonLine<{ type: string; provider: string; usage: Record<string, number> }>(stdout);

    expect(firstDelta.message.id).toBe('codex-item-1');
    expect(firstDelta.message.model).toBe('gpt-5.5');
    expect(secondDelta.message.id).toBe('codex-item-1');
    expect(firstDelta.message.content[0].text).toBe('CAR');
    expect(secondDelta.message.content[0].text).toBe('ROT');
    expect(turnEnd).toMatchObject({ type: 'result', provider: 'codex' });
    expect(turnEnd.usage).toMatchObject({ input_tokens: 1_510, cache_read_input_tokens: 95_744, output_tokens: 465 });

    handle.write('follow up', { model: 'gpt-5.6-terra', reasoningEffort: 'ultra' });
    expect(client.startTurnCalls[1]).toMatchObject({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'ultra',
    });
    expect(client.startTurnCalls[1]?.input[0]).toMatchObject({ type: 'text', text: 'follow up' });
    handle.signal('SIGINT');
    expect(client.interrupts[0]).toEqual({ threadId: 'thread-test-1', turnId: 'turn-2' });
  });

  it('converts base64 image attachments to Codex image inputs without dropping them', async () => {
    const client = new FakeCodexClient();
    const adapter = new CodexProcessAdapter(() => {}, () => client);
    const handle = await adapter.spawn({
      prompt: '',
      cwd: '/tmp/codex-test',
      extra: {
        provider: 'codex',
        sessionId: 'conv-test',
        attachments: [{
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'cG5n' },
        }],
      },
    });

    expect(client.startTurnCalls[0]?.input).toEqual([{
      type: 'image',
      url: 'data:image/png;base64,cG5n',
      detail: null,
    }]);
    expect(() => handle.write('', {
      attachments: [{
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' },
      }],
    })).toThrow('not PDF attachments');
    handle.signal('SIGTERM');
  });

  // The shapes below are taken from real `mcpToolCall` items in ~/.lattice/session-info.db:
  // `arguments` is a JSON string, and `result` is the MCP envelope
  // `{ _meta, content, structuredContent }`.
  describe('mcpToolCall items', () => {
    async function spawnAdapter() {
      const client = new FakeCodexClient();
      const adapter = new CodexProcessAdapter(() => {}, () => client);
      const handle = await adapter.spawn({
        prompt: '',
        cwd: '/tmp/codex-test',
        extra: { provider: 'codex', sessionId: 'conv-test' },
      });
      const stdout = handle.stdout[Symbol.asyncIterator]();
      await readJsonLine(stdout); // system init
      return { client, handle, stdout };
    }

    function emitItem(client: FakeCodexClient, method: 'item/started' | 'item/completed', item: Record<string, unknown>) {
      client.emitNotification({
        method,
        params: { threadId: 'thread-test-1', turnId: 'turn-1', item, startedAtMs: 0, completedAtMs: 1 },
      } as CodexServerNotification);
    }

    it('names the tool the way Claude does and publishes the parsed arguments', async () => {
      const { client, handle, stdout } = await spawnAdapter();
      emitItem(client, 'item/started', {
        type: 'mcpToolCall',
        id: 'item-mcp-1',
        server: 'linear',
        tool: 'linear_get_issue',
        arguments: '{"issueId":"SLING-1234"}',
      });

      const toolUse = await readJsonLine<{ message: { content: Array<{ name: string; input: Record<string, unknown> }> } }>(stdout);
      expect(toolUse.message.content[0].name).toBe('mcp__linear__linear_get_issue');
      expect(toolUse.message.content[0].input).toEqual({ issueId: 'SLING-1234' });
      handle.signal('SIGTERM');
    });

    it('hands the renderer the tool payload rather than the protocol envelope', async () => {
      const { client, handle, stdout } = await spawnAdapter();
      emitItem(client, 'item/started', {
        type: 'mcpToolCall', id: 'item-mcp-2', server: 'slack', tool: 'channels_list',
        arguments: '{"limit":10}',
      });
      await readJsonLine(stdout);

      emitItem(client, 'item/completed', {
        type: 'mcpToolCall', id: 'item-mcp-2', server: 'slack', tool: 'channels_list',
        status: 'completed', arguments: '{"limit":10}',
        result: { _meta: null, content: [{ type: 'text', text: 'ID,Name\nC1,general' }], structuredContent: null },
      });

      const result = await readJsonLine<{ message: { content: Array<{ content: string; is_error?: boolean }> } }>(stdout);
      expect(result.message.content[0].content).toBe('ID,Name\nC1,general');
      expect(result.message.content[0].is_error).toBeUndefined();
      handle.signal('SIGTERM');
    });

    it('prefers structuredContent when content[] is only a stub acknowledgement', async () => {
      const { client, handle, stdout } = await spawnAdapter();
      emitItem(client, 'item/started', {
        type: 'mcpToolCall', id: 'item-mcp-3', server: 'github', tool: 'search_prs',
        arguments: '{"query":"is:open"}',
      });
      await readJsonLine(stdout);

      emitItem(client, 'item/completed', {
        type: 'mcpToolCall', id: 'item-mcp-3', server: 'github', tool: 'search_prs',
        status: 'completed', arguments: '{"query":"is:open"}',
        result: {
          content: [{ type: 'text', text: 'Action completed.' }],
          structuredContent: { issues: [{ number: 7, title: 'Fix routing' }] },
        },
      });

      const result = await readJsonLine<{ message: { content: Array<{ content: string }> } }>(stdout);
      expect(JSON.parse(result.message.content[0].content)).toEqual({
        issues: [{ number: 7, title: 'Fix routing' }],
      });
      handle.signal('SIGTERM');
    });

    it('keeps the whole envelope when the arguments never arrived, so the call is still legible', async () => {
      const { client, handle, stdout } = await spawnAdapter();
      emitItem(client, 'item/started', {
        type: 'mcpToolCall', id: 'item-mcp-4', server: 'notion', tool: 'API-post-search',
      });
      const toolUse = await readJsonLine<{ message: { content: Array<{ input: Record<string, unknown> }> } }>(stdout);
      expect(toolUse.message.content[0].input).toEqual({});

      emitItem(client, 'item/completed', {
        type: 'mcpToolCall', id: 'item-mcp-4', server: 'notion', tool: 'API-post-search',
        status: 'completed', arguments: '{"query":"roadmap"}',
        result: { content: [{ type: 'text', text: 'one result' }] },
      });

      const result = await readJsonLine<{ message: { content: Array<{ content: string }> } }>(stdout);
      expect(JSON.parse(result.message.content[0].content)).toMatchObject({
        type: 'mcpToolCall',
        arguments: '{"query":"roadmap"}',
      });
      handle.signal('SIGTERM');
    });

    it('marks a failed call as an error result', async () => {
      const { client, handle, stdout } = await spawnAdapter();
      emitItem(client, 'item/started', {
        type: 'mcpToolCall', id: 'item-mcp-5', server: 'github', tool: 'get_pr', arguments: '{"number":1}',
      });
      await readJsonLine(stdout);

      emitItem(client, 'item/completed', {
        type: 'mcpToolCall', id: 'item-mcp-5', server: 'github', tool: 'get_pr',
        status: 'failed', arguments: '{"number":1}',
        result: { content: [{ type: 'text', text: 'GitHub API error 404' }] },
      });

      const result = await readJsonLine<{ message: { content: Array<{ is_error?: boolean }> } }>(stdout);
      expect(result.message.content[0].is_error).toBe(true);
      handle.signal('SIGTERM');
    });
  });

  it('renders fileChange items as a patch instead of dropping them', async () => {
    const client = new FakeCodexClient();
    const adapter = new CodexProcessAdapter(() => {}, () => client);
    const handle = await adapter.spawn({
      prompt: '',
      cwd: '/tmp/codex-test',
      extra: { provider: 'codex', sessionId: 'conv-test' },
    });
    const stdout = handle.stdout[Symbol.asyncIterator]();
    await readJsonLine(stdout); // system init

    const changes = [{ path: '/tmp/codex-test/src/app.ts', diff: '@@ -1,1 +1,1 @@\n-old\n+new' }];
    client.emitNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-test-1', turnId: 'turn-1', startedAtMs: 0,
        item: { type: 'fileChange', id: 'item-fc-1', status: 'inProgress', changes },
      },
    } as CodexServerNotification);

    const toolUse = await readJsonLine<{ message: { content: Array<{ name: string; input: Record<string, unknown> }> } }>(stdout);
    expect(toolUse.message.content[0].name).toBe('ApplyPatch');
    expect(toolUse.message.content[0].input).toMatchObject({ changes, cwd: '/tmp/codex-test' });

    client.emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-test-1', turnId: 'turn-1', completedAtMs: 1,
        item: { type: 'fileChange', id: 'item-fc-1', status: 'completed', changes },
      },
    } as CodexServerNotification);

    const result = await readJsonLine<{ message: { content: Array<{ content: string; is_error?: boolean }> } }>(stdout);
    expect(result.message.content[0].content).toBe('Applied 1 file change');
    expect(result.message.content[0].is_error).toBeUndefined();
    handle.signal('SIGTERM');
  });

  it('turns a request_user_input_async question into a decision card instead of a message', async () => {
    const client = new FakeCodexClient();
    const lifecycleEvents: Array<{ type: string; data: unknown }> = [];
    const adapter = new CodexProcessAdapter((event) => lifecycleEvents.push({ type: event.type, data: event.data }), () => client);
    const handle = await adapter.spawn({ prompt: '', cwd: '/tmp/codex-test', extra: { provider: 'codex', sessionId: 'conv-test' } });
    const stdout = handle.stdout[Symbol.asyncIterator]();
    await readJsonLine(stdout); // system init

    // As codex-cli 0.155.1 sent it on 2026-09-27 (gpt-6-astra).
    const options = ['Tabs — Use tab characters for each indentation level.', 'Spaces — Use space characters for each indentation level.'];
    client.emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-test-1', turnId: 'turn-1', completedAtMs: 1,
        item: {
          type: 'agentMessage', id: 'call_IO1Mq2k0X3ggAVkCWDEQeUpo',
          text: `Which indentation should this new repo use?\n- ${options[0]}\n- ${options[1]}`,
          phase: 'final_answer', delivery: 'async',
          questions: [{ title: 'Which indentation should this new repo use?', options }],
        },
      },
    } as CodexServerNotification);
    client.emitNotification({
      method: 'item/completed',
      params: { threadId: 'thread-test-1', turnId: 'turn-1', completedAtMs: 2, item: { type: 'agentMessage', id: 'item-2', text: 'After.' } },
    } as CodexServerNotification);

    const next = await readJsonLine<{ message: { content: Array<{ text: string }> } }>(stdout);
    expect(next.message.content[0].text).toBe('After.');
    expect(lifecycleEvents).toEqual([{
      type: 'decision:asked',
      data: {
        id: expect.any(String),
        question: 'Which indentation should this new repo use?',
        options: options.map((label) => ({ label, consequence: '' })),
        holdsTurn: true,
      },
    }]);
    handle.signal('SIGTERM');
  });

  it('uses native compaction, projects its lifecycle, and queues normal input behind it', async () => {
    const client = new FakeCodexClient();
    const lifecycleEvents: Array<{ type: string; data: unknown }> = [];
    const adapter = new CodexProcessAdapter(
      (event) => lifecycleEvents.push({ type: event.type, data: event.data }),
      () => client,
    );
    const handle = await adapter.spawn({
      prompt: '',
      cwd: '/tmp/codex-test',
      extra: { provider: 'codex', sessionId: 'conv-test' },
    });
    const stdout = handle.stdout[Symbol.asyncIterator]();
    await readJsonLine(stdout); // system init

    await handle.compact?.();
    expect(client.compactionCalls).toEqual(['thread-test-1']);

    handle.write('wait until compaction finishes');
    expect(client.startTurnCalls).toHaveLength(0);

    client.emitNotification({
      method: 'turn/started',
      params: { threadId: 'thread-test-1', turn: { id: 'turn-compact-1' } },
    });
    client.emitNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-test-1',
        turnId: 'turn-compact-1',
        item: { type: 'contextCompaction', id: 'compact-1' },
        startedAtMs: 1_000,
      },
    });
    client.emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-test-1',
        turnId: 'turn-compact-1',
        item: { type: 'contextCompaction', id: 'compact-1' },
        completedAtMs: 1_275,
      },
    });

    expect(lifecycleEvents).toEqual([
      { type: 'context:compaction', data: { phase: 'started' } },
      { type: 'context:compaction', data: { phase: 'completed', result: 'success' } },
    ]);
    expect(await readJsonLine(stdout)).toMatchObject({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', duration_ms: 275 },
      provider: 'codex',
    });

    client.emitNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thread-test-1',
        turn: { id: 'turn-compact-1', status: 'completed', durationMs: 275 },
      },
    });
    await Promise.resolve();

    expect(client.startTurnCalls[0]?.input[0]).toMatchObject({
      type: 'text',
      text: 'wait until compaction finishes',
    });
    handle.signal('SIGTERM');
  });

  it('refuses to start a thread when the app-server reports no signed-in account', async () => {
    const client = new FakeCodexClient();
    client.accountRead = { account: null, requiresOpenaiAuth: true };
    const adapter = new CodexProcessAdapter(() => {}, () => client);

    await expect(adapter.spawn({
      prompt: 'hello',
      cwd: '/tmp/codex-test',
      args: [],
      extra: { provider: 'codex', sessionId: 'conv-signed-out' },
    })).rejects.toThrow(CODEX_NOT_SIGNED_IN_MESSAGE);
    expect(client.startThreadCalls).toEqual([]);
  });

  it('fails the active turn and closes the handle when the app-server exits', async () => {
    const client = new FakeCodexClient();
    const adapter = new CodexProcessAdapter(() => {}, () => client);
    const handle = await adapter.spawn({
      prompt: 'hello',
      cwd: '/tmp/codex-test',
      args: [],
      extra: { provider: 'codex', sessionId: 'conv-exit' },
    });
    const stdout = handle.stdout[Symbol.asyncIterator]();
    await readJsonLine(stdout); // system init

    client.emit('exit', { code: 1, signal: null });

    expect(await readJsonLine<{ message: { content: Array<{ text: string }> } }>(stdout)).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Codex app-server exited mid-turn (code=1, signal=null)' }] },
    });
    expect(await readJsonLine(stdout)).toMatchObject({ type: 'result', is_error: true });
    expect(handle.alive).toBe(false);
    await expect(handle.exited).resolves.toEqual({ code: 0, signal: undefined });
    expect(adapter.hasActiveThread('thread-test-1')).toBe(false);
    expect(client.listenerCount('exit')).toBe(0);
  });

  it('reports a setting once the app-server has taken it, and not while an input is parked', async () => {
    const client = new FakeCodexClient();
    const applied: Array<{ sessionId: string; model: string; reasoningEffort: string }> = [];
    const adapter = new CodexProcessAdapter(
      () => {},
      () => client,
      undefined,
      (settings) => applied.push(settings),
    );

    const handle = await adapter.spawn({
      prompt: 'first',
      cwd: '/tmp/codex-test',
      args: ['--model=gpt-6-astra'],
      extra: { provider: 'codex', sessionId: 'conv-effort', reasoningEffort: 'medium' },
    });

    // The thread, then its first turn.
    expect(applied).toEqual([
      { sessionId: 'conv-effort', model: 'gpt-6-astra', reasoningEffort: 'medium' },
      { sessionId: 'conv-effort', model: 'gpt-6-astra', reasoningEffort: 'medium' },
    ]);

    // A change sent mid-turn is parked, not applied — reporting it here would
    // record a setting the thread is not running at.
    handle.write('second\n', { reasoningEffort: 'low' });
    expect(applied).toHaveLength(2);
    expect(client.startTurnCalls).toHaveLength(1);

    client.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-test-1', turn: { id: 'turn-1', status: 'completed', durationMs: 1 } },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(client.startTurnCalls[1]).toMatchObject({ reasoningEffort: 'low' });
    expect(applied[2]).toEqual({ sessionId: 'conv-effort', model: 'gpt-6-astra', reasoningEffort: 'low' });
  });
});

/**
 * Steering a Codex turn.
 *
 * Codex's acceptance is stronger than Claude's: `expectedTurnId` is a
 * precondition, so a response that names our turn is already proof the input
 * joined the turn that was running. The cases worth pinning are the ones
 * where it does not: a refusal must leave the caller holding the input, and
 * anything that is not a refusal must not be reported as one.
 */
describe('CodexProcessAdapter steering', () => {
  async function running(): Promise<{ client: FakeCodexClient; handle: ProcessHandle }> {
    const client = new FakeCodexClient();
    const adapter = new CodexProcessAdapter(() => {}, () => client);
    const handle = await adapter.spawn({
      prompt: 'start the work',
      cwd: '/tmp/codex-test',
      extra: { provider: 'codex', sessionId: 'conv-test', reasoningEffort: 'medium' },
    });
    // The spawn's first turn is what makes a turn active to steer into.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { client, handle };
  }

  it('sends the running turn id and the delivery id, and reports incorporation mid-turn', async () => {
    const { client, handle } = await running();
    const seen: SteerStage[] = [];

    const outcome = await handle.steer!({
      input: 'correction',
      deliveryId: 'delivery-1',
      onStage: (stage) => seen.push(stage),
    });

    expect(outcome).toMatchObject({ status: 'accepted' });
    expect(client.steerCalls).toHaveLength(1);
    expect(client.steerCalls[0]).toMatchObject({
      expectedTurnId: 'turn-1',
      clientUserMessageId: 'delivery-1',
    });
    // No new turn: steering is not a send.
    expect(client.startTurnCalls).toHaveLength(1);
    expect(seen).toEqual([
      { kind: 'handed-over' },
      { kind: 'accepted', late: false, detail: expect.objectContaining({ turnId: 'turn-1' }) },
      { kind: 'incorporated', where: 'mid-turn', evidence: expect.stringContaining('turn-1') },
    ]);
  });

  it('rejects when the app-server refuses, so the caller keeps the input', async () => {
    const { client, handle } = await running();
    client.steerBehaviour = 'refuse';

    const outcome = await handle.steer!({ input: 'correction', deliveryId: 'delivery-1' });

    expect(outcome.status).toBe('rejected');
    expect(outcome).toMatchObject({ reason: expect.stringContaining('expected active turn id') });
  });

  it('is uncertain when the call never gets an answer, because silence is not a refusal', async () => {
    const { client, handle } = await running();
    client.steerBehaviour = 'hang';

    const outcome = await handle.steer!({ input: 'correction', deliveryId: 'delivery-1' });

    expect(outcome.status).toBe('uncertain');
  });

  it('is uncertain when the answer names a turn we did not aim at', async () => {
    const { client, handle } = await running();
    client.steerBehaviour = 'wrong-turn';

    const outcome = await handle.steer!({ input: 'correction', deliveryId: 'delivery-1' });

    expect(outcome.status).toBe('uncertain');
  });

  it('rejects with no call at all when no turn is running', async () => {
    const client = new FakeCodexClient();
    const adapter = new CodexProcessAdapter(() => {}, () => client);
    const handle = await adapter.spawn({
      prompt: '',
      cwd: '/tmp/codex-test',
      extra: { provider: 'codex', sessionId: 'conv-test', reasoningEffort: 'medium' },
    });

    const outcome = await handle.steer!({ input: 'correction', deliveryId: 'delivery-1' });

    expect(outcome.status).toBe('rejected');
    expect(client.steerCalls).toHaveLength(0);
  });
});
