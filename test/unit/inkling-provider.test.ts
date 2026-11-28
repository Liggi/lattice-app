/**
 * The Inkling provider: tool mapping, the permission bridge over a real
 * tracker, and the adapter driving the real `inkling acp` against a fake
 * OpenAI-compatible model server (skipped when `inkling` is not installed).
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProcessHandle } from '@liggi/agent-ui-harness/server';
import {
  InklingProcessAdapter,
  inklingBinary,
  inklingPromptWithAttachments,
  inklingToolUse,
  type InklingApprovalRequest,
  type InklingPermissionBridge,
} from '../../src/harness/inkling-process-adapter.js';
import { createInklingPermissionBridge, decisionForMode } from '../../src/services/inkling-permission-bridge.js';
import { PermissionTracker } from '../../src/services/permission-tracker.js';
import { providerForModel } from '../../src/constants/model-provider.js';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';

describe('Inkling tool calls as Lattice tools', () => {
  const cwd = '/work';
  it('draws each Inkling tool as the Claude tool the chat knows', () => {
    expect(inklingToolUse('run_shell', { command: 'ls', timeout: 5 }, cwd)).toEqual({ name: 'Bash', input: { command: 'ls', timeout: 5000 } });
    expect(inklingToolUse('read_file', { path: 'a.txt', offset: 3 }, cwd)).toEqual({ name: 'Read', input: { file_path: '/work/a.txt', offset: 3 } });
    expect(inklingToolUse('write_file', { path: '/tmp/b', content: 'x' }, cwd)).toEqual({ name: 'Write', input: { file_path: '/tmp/b', content: 'x' } });
    expect(inklingToolUse('edit_file', { path: 'c', old_string: 'a', new_string: 'b' }, cwd))
      .toEqual({ name: 'Edit', input: { file_path: '/work/c', old_string: 'a', new_string: 'b' } });
    expect(inklingToolUse('list_files', {}, cwd)).toEqual({ name: 'LS', input: { path: '/work' } });
    expect(inklingToolUse('search_files', { pattern: 'foo', glob: '*.ts' }, cwd)).toEqual({ name: 'Grep', input: { pattern: 'foo', glob: '*.ts' } });
    expect(inklingToolUse('web_search', { query: 'q' }, cwd)).toEqual({ name: 'WebSearch', input: { query: 'q' } });
    expect(inklingToolUse('fetch_url', { url: 'https://x' }, cwd)).toEqual({ name: 'WebFetch', input: { url: 'https://x' } });
    expect(inklingToolUse('mystery', { a: 1 }, cwd)).toEqual({ name: 'mystery', input: { a: 1 } });
  });

  it('expands ~ in paths', () => {
    expect(inklingToolUse('read_file', { path: '~/notes.md' }, cwd).input.file_path).toBe(path.join(os.homedir(), 'notes.md'));
  });

  it('sends attached text inline and refuses images', () => {
    expect(inklingPromptWithAttachments('hi', [{ type: 'text', text: 'file body' }])).toBe('file body\n\nhi');
    expect(() => inklingPromptWithAttachments('hi', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }]))
      .toThrow(/text only/);
  });

  it('routes inkling: model ids to the inkling provider', () => {
    expect(providerForModel('inkling:inkling-2-mini')).toBe('inkling');
  });
});

describe('Inkling permission bridge', () => {
  let tracker: PermissionTracker;
  let mode: string | undefined;
  let bridge: InklingPermissionBridge;
  const ask = (toolName = 'Bash', toolInput: Record<string, unknown> = { command: 'rm -rf build' }): InklingApprovalRequest => ({
    conversationId: 'conv-inkling-test', streamingId: 'inkling-1', toolName, toolInput, preview: '',
  });

  beforeEach(async () => {
    ConversationService.resetInstance();
    DatabaseProvider.resetInstance();
    await new SessionInfoService(':memory:').initialize();
    tracker = new PermissionTracker();
    mode = 'default';
    bridge = createInklingPermissionBridge(tracker, () => mode);
  });
  afterEach(() => {
    tracker.stopExpiryCheck();
    tracker.clear();
    ConversationService.resetInstance();
    DatabaseProvider.resetInstance();
  });

  it('lets the permission mode decide without a card', async () => {
    expect(decisionForMode('bypassPermissions', 'Bash')).toBe('allow');
    expect(decisionForMode('auto', 'Write')).toBe('allow');
    expect(decisionForMode('acceptEdits', 'Edit')).toBe('allow');
    expect(decisionForMode('acceptEdits', 'Bash')).toBe('ask');
    expect(decisionForMode('default', 'Write')).toBe('ask');
    mode = 'bypassPermissions';
    expect(await bridge.decide(ask())).toEqual({ allow: true });
    expect(tracker.size()).toBe(0);
  });

  it('raises a card in ask mode and allows when it is approved', async () => {
    const decision = bridge.decide(ask());
    const [card] = tracker.getPermissionRequests({ status: 'pending' });
    expect(card).toMatchObject({ toolName: 'Bash', toolInput: { command: 'rm -rf build' }, streamingId: 'inkling-1', sessionId: 'conv-inkling-test' });
    tracker.updatePermissionStatus(card.id, 'approved');
    expect(await decision).toEqual({ allow: true });
  });

  it('passes a denial reason back as feedback', async () => {
    const decision = bridge.decide(ask());
    const [card] = tracker.getPermissionRequests({ status: 'pending' });
    tracker.updatePermissionStatus(card.id, 'denied', { denyReason: 'use make clean' });
    expect(await decision).toEqual({ allow: false, feedback: 'use make clean' });
  });

  it('withdraws an undecided card when the turn ends', async () => {
    const decision = bridge.decide(ask());
    bridge.withdraw('inkling-1');
    expect(await decision).toMatchObject({ allow: false });
    expect(tracker.getPermissionRequests({ status: 'pending' })).toEqual([]);
  });
});

// ---- the adapter against the real `inkling acp` ----

type Line = Record<string, any>;
type ChatMessage = { role: string; content?: string; tool_calls?: unknown[] };

/** A model that answers from the last message: enough to drive tool calls, cancels and resume. */
function fakeModel(messages: ChatMessage[]): { content?: string; tool?: { name: string; args: Record<string, unknown> } } {
  const last = messages[messages.length - 1];
  if (last.role === 'tool') return { content: `Tool said: ${String(last.content).slice(0, 60)}` };
  const text = String(last.content ?? '');
  if (text.includes('write it')) return { tool: { name: 'write_file', args: { path: 'out.txt', content: 'hello' } } };
  if (text.includes('sleep')) return { tool: { name: 'run_shell', args: { command: 'sleep 20' } } };
  if (text.includes('my number')) {
    const earlier = messages.slice(1, -1).some((m) => String(m.content ?? '').includes('number is 7'));
    return { content: earlier ? 'Your number is 7.' : 'I do not know your number.' };
  }
  return { content: 'Hello from the fake model.' };
}

function startFakeServer(): Promise<{ url: string; close: () => Promise<void>; requests: ChatMessage[][] }> {
  const requests: ChatMessage[][] = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.end('{"status":"ok"}'); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { messages } = JSON.parse(body) as { messages: ChatMessage[] };
      requests.push(messages);
      const reply = fakeModel(messages);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      send({ choices: [{ delta: { reasoning_content: 'thinking briefly' } }] });
      if (reply.content) {
        for (const piece of reply.content.match(/.{1,6}/g) ?? []) send({ choices: [{ delta: { content: piece } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      } else if (reply.tool) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      }
      send({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 7 } });
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((done) => server.close(() => done())),
    requests,
  })));
}

/** Reads lines until a `result`, answering nothing else. */
async function readTurn(handle: ProcessHandle, lines: Line[]): Promise<Line> {
  for await (const raw of handle.stdout) {
    const line = JSON.parse(raw) as Line;
    lines.push(line);
    if (line.type === 'result') return line;
  }
  throw new Error('stdout ended before a result');
}

const blocks = (lines: Line[], type: string) => lines.flatMap((l) => (l.message?.content ?? []) as Line[]).filter((b) => b.type === type);

describe.skipIf(!inklingBinary())('Inkling adapter over the real inkling acp', () => {
  let fake: Awaited<ReturnType<typeof startFakeServer>>;
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const decisions: InklingApprovalRequest[] = [];
  let answer: (req: InklingApprovalRequest) => Promise<{ allow: true } | { allow: false; feedback?: string }>;
  const bridge: InklingPermissionBridge = {
    decide: (req) => { decisions.push(req); return answer(req); },
    withdraw: () => {},
  };
  const handles: ProcessHandle[] = [];
  const spawn = async (prompt: string, resume?: string) => {
    const handle = await new InklingProcessAdapter(() => bridge).spawn({ prompt, cwd: dir, ...(resume ? { resume } : {}), extra: { sessionId: 'conv-test' } });
    handles.push(handle);
    return handle;
  };

  beforeAll(async () => {
    fake = await startFakeServer();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkling-adapter-'));
    for (const key of ['INKLING_BASE_URL', 'INKLING_HOME']) saved[key] = process.env[key];
    process.env.INKLING_BASE_URL = fake.url;
    process.env.INKLING_HOME = path.join(dir, '.inkling-home');
  });
  afterAll(async () => {
    for (const h of handles) h.signal('SIGTERM');
    await Promise.all(handles.map((h) => h.exited));
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => { decisions.length = 0; });

  it('streams thinking, a tool call, its result and the answer, with an approved write', async () => {
    answer = async () => ({ allow: true });
    const handle = await spawn('write it');
    const lines: Line[] = [];
    const result = await readTurn(handle, lines);
    expect(lines[0]).toMatchObject({ type: 'system', subtype: 'init', provider: 'inkling' });
    expect(result).toMatchObject({ type: 'result', is_error: false, subtype: 'success' });
    expect(decisions[0]).toMatchObject({ conversationId: 'conv-test', toolName: 'Write', toolInput: { file_path: path.join(dir, 'out.txt'), content: 'hello' } });
    const [use] = blocks(lines, 'tool_use');
    expect(use).toMatchObject({ name: 'Write', input: { file_path: path.join(dir, 'out.txt') } });
    const [res] = blocks(lines, 'tool_result');
    expect(res.tool_use_id).toBe(use.id);
    expect(res.is_error).toBeUndefined();
    expect(blocks(lines, 'thinking')[0].thinking).toBe('thinking briefly');
    expect(blocks(lines, 'text').at(-1)!.text).toMatch(/^Tool said: /);
    expect(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe('hello');
  });

  it('tells the model why a denied call was refused', async () => {
    fs.rmSync(path.join(dir, 'out.txt'), { force: true });
    answer = async () => ({ allow: false, feedback: 'name it notes.txt instead' });
    const handle = await spawn('write it');
    const lines: Line[] = [];
    await readTurn(handle, lines);
    const [res] = blocks(lines, 'tool_result');
    expect(res.is_error).toBe(true);
    expect(res.content).toContain('name it notes.txt instead');
    expect(fs.existsSync(path.join(dir, 'out.txt'))).toBe(false);
  });

  it('cancels a running command on SIGINT and stays up for the next turn', async () => {
    answer = async () => ({ allow: true });
    const handle = await spawn('sleep please');
    const lines: Line[] = [];
    const turn = readTurn(handle, lines);
    while (!blocks(lines, 'tool_use').length) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    handle.signal('SIGINT');
    const result = await turn;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result).toMatchObject({ is_error: true });
    expect(blocks(lines, 'tool_result')).toMatchObject([{ tool_use_id: blocks(lines, 'tool_use')[0].id, is_error: true }]);
    expect(handle.alive).toBe(true);
    handle.write('hello again\n');
    const next: Line[] = [];
    expect(await readTurn(handle, next)).toMatchObject({ is_error: false });
    expect(blocks(next, 'text').at(-1)!.text).toBe('Hello from the fake model.');
  });

  it('resumes a saved session in a new process with its history', async () => {
    const first = await spawn('remember: my number is 7');
    const lines: Line[] = [];
    await readTurn(first, lines);
    const sessionId = lines[0].session_id as string;
    first.signal('SIGTERM');
    await first.exited;

    const second = await spawn('what is my number?', sessionId);
    const next: Line[] = [];
    await readTurn(second, next);
    expect(next[0].session_id).toBe(sessionId);
    const ids = (ls: Line[]) => ls.filter((l) => l.type === 'assistant').map((l) => l.message.id as string);
    expect(ids(next).filter((id) => ids(lines).includes(id))).toEqual([]);
    expect(blocks(next, 'text').at(-1)!.text).toBe('Your number is 7.');
  });
});
