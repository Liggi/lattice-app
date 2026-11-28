/**
 * The Antigravity adapter against a fake `agy acp`: a prompt sent while a
 * turn runs steers it into one Lattice turn, and SIGINT cancels the turn
 * without stopping agy.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProcessHandle, SteerStage } from '@liggi/agent-ui-harness/server';
import { AntigravityProcessAdapter } from '../../src/harness/antigravity-process-adapter.js';

// Speaks just enough ACP: the first prompt starts a tool call and waits; a
// second prompt answers the first at once, as agy does when steered, then
// finishes the tool and replies. session/cancel answers every open prompt.
const FAKE_AGY = `#!/usr/bin/env node
const readline = require('node:readline');
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const update = (u) => send({ method: 'session/update', params: { sessionId: 's1', update: u } });
const open = [];
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize' || m.method === 'session/set_model') return send({ id: m.id, result: {} });
  if (m.method === 'session/new') return send({ id: m.id, result: { sessionId: 's1' } });
  if (m.method === 'session/cancel') {
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', name: 'run_command', status: 'failed', rawOutput: { output: '' } });
    while (open.length) send({ id: open.shift(), result: { stopReason: 'cancelled' } });
    return;
  }
  if (m.method !== 'session/prompt') return;
  const text = m.params.prompt[0].text;
  if (text === 'quick') {
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Quick thought.' } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } });
    return send({ id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 1 } } });
  }
  if (open.length === 0) {
    open.push(m.id);
    update({ sessionUpdate: 'usage_update', used: 1000 });
    update({ sessionUpdate: 'tool_call', toolCallId: 't1', name: 'run_command', args: { CommandLine: 'sleep 5' }, status: 'in_progress' });
    return;
  }
  send({ id: open.shift(), result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } } });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', name: 'run_command', status: 'completed', rawOutput: { output: 'slept' } });
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'New instruction.' } });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Steered: ' + text } });
  send({ id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 3 } } });
});
`;

let dir: string;
let previousBin: string | undefined;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-agy-'));
  fs.writeFileSync(path.join(dir, 'agy'), FAKE_AGY, { mode: 0o755 });
  previousBin = process.env.LATTICE_AGY_BIN;
  process.env.LATTICE_AGY_BIN = path.join(dir, 'agy');
});

afterAll(() => {
  if (previousBin === undefined) delete process.env.LATTICE_AGY_BIN;
  else process.env.LATTICE_AGY_BIN = previousBin;
  fs.rmSync(dir, { recursive: true, force: true });
});

type Line = Record<string, any>;

/** Reads the handle's stdout and calls `on` for each line, until a result for which `on` returns true. */
async function readUntil(handle: ProcessHandle, lines: Line[], on: (line: Line) => boolean | void): Promise<void> {
  for await (const raw of handle.stdout) {
    const line = JSON.parse(raw) as Line;
    lines.push(line);
    if (on(line) === true) return;
  }
}

describe('Antigravity over ACP', () => {
  it('steers a message into the running turn and ends it with one result', async () => {
    const handle = await new AntigravityProcessAdapter().spawn({ prompt: 'run the sleep', cwd: dir, extra: { sessionId: 't' } });
    const lines: Line[] = [];
    const stages: SteerStage[] = [];
    let outcome: Promise<unknown> | undefined;
    await readUntil(handle, lines, (line) => {
      if (!outcome && line.type === 'assistant' && line.message.content[0].type === 'tool_use') {
        outcome = handle.steer!({ input: 'say banana\n', deliveryId: 'd1', onStage: (s) => stages.push(s) });
      }
      return line.type === 'result';
    });

    expect(await outcome).toMatchObject({ status: 'accepted' });
    expect(stages.map((s) => s.kind)).toEqual(['handed-over', 'accepted', 'incorporated']);
    expect(lines.filter((l) => l.type === 'result')).toHaveLength(1);
    const result = lines.find((l) => l.type === 'result')!;
    expect(result).toMatchObject({ is_error: false, usage: { input_tokens: 30, output_tokens: 5 } });
    const blocks = lines.filter((l) => l.type !== 'result' && l.type !== 'system').map((l) => l.message.content[0]);
    expect(blocks.map((b) => b.type)).toEqual(['tool_use', 'tool_result', 'thinking', 'text']);
    expect(blocks[1].content).toBe('slept');
    expect(blocks[3].text).toBe('Steered: say banana');
    handle.signal('SIGTERM');
    await handle.exited;
  });

  it('refuses to steer when no turn is running', async () => {
    const handle = await new AntigravityProcessAdapter().spawn({ prompt: 'quick', cwd: dir, extra: { sessionId: 't' } });
    await readUntil(handle, [], (line) => line.type === 'result');
    expect(await handle.steer!({ input: 'late', deliveryId: 'd2' })).toMatchObject({ status: 'rejected' });
    handle.signal('SIGTERM');
    await handle.exited;
  });

  it('cancels the turn on SIGINT and keeps agy up for the next message', async () => {
    const handle = await new AntigravityProcessAdapter().spawn({ prompt: 'run the sleep', cwd: dir, extra: { sessionId: 't' } });
    const lines: Line[] = [];
    await readUntil(handle, lines, (line) => {
      if (line.type === 'assistant' && line.message.content[0].type === 'tool_use') handle.signal('SIGINT');
      return line.type === 'result';
    });
    expect(lines.at(-1)).toMatchObject({ type: 'result', is_error: true });
    expect(handle.alive).toBe(true);

    handle.write('quick\n');
    const next: Line[] = [];
    await readUntil(handle, next, (line) => line.type === 'result');
    expect(next.at(-1)).toMatchObject({ type: 'result', is_error: false });
    handle.signal('SIGTERM');
    await handle.exited;
  });

  it('gives each spawned handle unique thinking and text message ids across respawns', async () => {
    const adapter = new AntigravityProcessAdapter();
    const first = await adapter.spawn({ prompt: 'quick', cwd: dir, extra: { sessionId: 't-respawn' } });
    const firstLines: Line[] = [];
    await readUntil(first, firstLines, (line) => line.type === 'result');
    first.signal('SIGTERM');
    await first.exited;

    const second = await adapter.spawn({ prompt: 'quick', cwd: dir, extra: { sessionId: 't-respawn' } });
    const secondLines: Line[] = [];
    await readUntil(second, secondLines, (line) => line.type === 'result');
    second.signal('SIGTERM');
    await second.exited;

    const firstIds = firstLines.filter((l) => l.type === 'assistant').map((l) => l.message.id as string);
    const secondIds = secondLines.filter((l) => l.type === 'assistant').map((l) => l.message.id as string);
    expect(firstIds).toHaveLength(2);
    expect(secondIds).toHaveLength(2);
    for (const id of secondIds) {
      expect(firstIds).not.toContain(id);
    }
  });
});
