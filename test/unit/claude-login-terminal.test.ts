/**
 * The daemon-owned terminal a person signs in to Claude through.
 *
 * What these pin down: a retried keystroke request cannot type twice, a
 * reconnecting screen sees each character once, a clean exit is not success
 * until the CLI's own status says so, and nothing the terminal shows reaches
 * a log line.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logCalls: Array<{ level: string; message: string; data: unknown }> = [];
vi.mock('../../src/services/infrastructure/logger.js', () => ({
  createLogger: () => ({
    debug: (message: string, data?: unknown) => logCalls.push({ level: 'debug', message, data }),
    info: (message: string, data?: unknown) => logCalls.push({ level: 'info', message, data }),
    warn: (message: string, data?: unknown) => logCalls.push({ level: 'warn', message, data }),
    error: (message: string, data?: unknown) => logCalls.push({ level: 'error', message, data }),
  }),
}));

const { ClaudeLoginTerminalManager, MAX_INPUT_CHARS } = await import('../../src/process-daemon/claude-login-terminal.js');
type Manager = InstanceType<typeof ClaudeLoginTerminalManager>;

interface FakePty {
  written: string[];
  size: { cols: number; rows: number };
  killed: boolean;
  emit: (data: string) => void;
  exit: (code: number) => void;
}

function fakePtyFactory(): { ptys: FakePty[]; spawn: (size: { cols: number; rows: number }) => import('../../src/process-daemon/claude-login-terminal.js').LoginTerminalProcess } {
  const ptys: FakePty[] = [];
  return {
    ptys,
    spawn: (size) => {
      let onData: (data: string) => void = () => {};
      let onExit: (exit: { exitCode: number }) => void = () => {};
      const fake: FakePty = {
        written: [],
        size: { ...size },
        killed: false,
        emit: (data) => onData(data),
        exit: (code) => onExit({ exitCode: code }),
      };
      ptys.push(fake);
      return {
        write: (data) => fake.written.push(data),
        resize: (cols, rows) => { fake.size = { cols, rows }; },
        kill: () => { fake.killed = true; },
        onData: (listener) => { onData = listener; },
        onExit: (listener) => { onExit = listener; },
      };
    },
  };
}

const SECRET_CODE = 'MARKER-authcode-7f3e2a9c#state';

function makeManager(overrides: { checkSignedIn?: () => Promise<boolean>; ttlMs?: number; bufferChars?: number } = {}): { manager: Manager; ptys: FakePty[] } {
  const factory = fakePtyFactory();
  const manager = new ClaudeLoginTerminalManager({
    spawn: factory.spawn,
    checkSignedIn: overrides.checkSignedIn ?? (async () => true),
    ...(overrides.ttlMs !== undefined ? { ttlMs: overrides.ttlMs } : {}),
    ...(overrides.bufferChars !== undefined ? { bufferChars: overrides.bufferChars } : {}),
  });
  return { manager, ptys: factory.ptys };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  logCalls.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ClaudeLoginTerminalManager', () => {
  it('runs one attempt at a time and rejoins it unless told to start over', () => {
    const { manager, ptys } = makeManager();
    const first = manager.start({ cols: 60, rows: 20 });
    const again = manager.start({ cols: 60, rows: 20 });
    expect(again).toEqual({ attemptId: first.attemptId, state: first.state, reused: true });
    expect(ptys).toHaveLength(1);

    const fresh = manager.start({ cols: 60, rows: 20 }, true);
    expect(fresh.reused).toBe(false);
    expect(fresh.attemptId).not.toBe(first.attemptId);
    expect(ptys[0].killed).toBe(true);
    expect(manager.getState(first.attemptId)?.phase).toBe('cancelled');
    expect(ptys).toHaveLength(2);
  });

  it('types a retried request only once, per browser client', () => {
    const { manager, ptys } = makeManager();
    const { attemptId } = manager.start(undefined);

    expect(manager.input(attemptId, 'phone', 1, 'a')).toEqual({ accepted: true, lastSeq: 1 });
    expect(manager.input(attemptId, 'phone', 2, `${SECRET_CODE}\r`)).toEqual({ accepted: true, lastSeq: 2 });
    // The response to seq 2 was lost on a flaky connection and the client retried it.
    expect(manager.input(attemptId, 'phone', 2, `${SECRET_CODE}\r`)).toEqual({ accepted: false, lastSeq: 2 });
    // A second tab keeps its own counter, so its first keystroke is not mistaken for a replay.
    expect(manager.input(attemptId, 'laptop', 1, 'b')).toEqual({ accepted: true, lastSeq: 1 });

    expect(ptys[0].written).toEqual(['a', `${SECRET_CODE}\r`, 'b']);
  });

  it('refuses input that is empty, oversized, or aimed at a finished attempt', () => {
    const { manager } = makeManager();
    const { attemptId } = manager.start(undefined);
    expect(() => manager.input(attemptId, 'c', 1, '')).toThrow('Input must be');
    expect(() => manager.input(attemptId, 'c', 1, 'x'.repeat(MAX_INPUT_CHARS + 1))).toThrow('Input must be');
    expect(() => manager.input(attemptId, 'c', 0, 'x')).toThrow('positive integer');
    manager.cancel(attemptId);
    expect(() => manager.input(attemptId, 'c', 1, 'x')).toThrow('not running');
  });

  it('replays the screen with an offset a live subscriber can cut over at, so nothing prints twice', () => {
    const { manager, ptys } = makeManager({ bufferChars: 8 });
    const { attemptId } = manager.start(undefined);
    const live: Array<{ data: string; offset: number }> = [];
    manager.on('output', (event) => live.push({ data: event.data, offset: event.offset }));

    ptys[0].emit('Opening ');
    ptys[0].emit('browser');
    const attached = manager.attach(attemptId)!;
    // Only the last 8 characters are kept; the offset still counts everything emitted.
    expect(attached.output).toBe(' browser');
    expect(attached.outputEnd).toBe(15);

    ptys[0].emit('…');
    expect(live).toEqual([
      { data: 'Opening ', offset: 0 },
      { data: 'browser', offset: 8 },
      { data: '…', offset: 15 },
    ]);
    expect(live.filter((chunk) => chunk.offset >= attached.outputEnd).map((chunk) => chunk.data)).toEqual(['…']);
  });

  it('is signed in only when the CLI exits cleanly AND its own status says so', async () => {
    const checks: boolean[] = [];
    const { manager, ptys } = makeManager({ checkSignedIn: async () => checks.shift() ?? false });
    const states: string[] = [];
    manager.on('state', (event) => states.push(event.state.phase));

    checks.push(true);
    const ok = manager.start(undefined);
    ptys[0].exit(0);
    await flush();
    expect(manager.getState(ok.attemptId)?.phase).toBe('succeeded');

    checks.push(false);
    const notReally = manager.start(undefined);
    ptys[1].exit(0);
    await flush();
    const state = manager.getState(notReally.attemptId);
    expect(state?.phase).toBe('failed');
    expect(state && 'reason' in state ? state.reason : '').toContain('not signed in');

    const crashed = manager.start(undefined);
    ptys[2].exit(1);
    await flush();
    const crashState = manager.getState(crashed.attemptId);
    expect(crashState && 'reason' in crashState ? crashState.reason : '').toBe('Claude Code exited with code 1');

    expect(states).toEqual(['succeeded', 'failed', 'failed']);
  });

  it('cancels a running attempt by killing its process, and reports a forgotten one as expired', () => {
    const { manager, ptys } = makeManager({ ttlMs: 1_000 });
    const { attemptId } = manager.start(undefined);
    expect(manager.cancel(attemptId)).toBe(true);
    expect(ptys[0].killed).toBe(true);
    expect(manager.getState(attemptId)?.phase).toBe('cancelled');
    expect(manager.cancel(attemptId)).toBe(false);

    const forgotten = manager.start(undefined);
    vi.advanceTimersByTime(1_001);
    const state = manager.getState(forgotten.attemptId);
    expect(ptys[1].killed).toBe(true);
    expect(state?.phase).toBe('failed');
    expect(state && 'reason' in state ? state.reason : '').toContain('not completed in time');
  });

  it('forgets the screen shortly after an attempt ends, and the attempt itself later', () => {
    const { manager, ptys } = makeManager();
    const { attemptId } = manager.start(undefined);
    ptys[0].emit(`Paste code here > ${SECRET_CODE}`);
    manager.cancel(attemptId);
    expect(manager.attach(attemptId)?.output).toContain(SECRET_CODE);
    vi.advanceTimersByTime(60_001);
    expect(manager.attach(attemptId)?.output).toBe('');
    vi.advanceTimersByTime(10 * 60_000);
    expect(manager.attach(attemptId)).toBeNull();
  });

  it('never puts terminal data or keystrokes in a log line', async () => {
    const { manager, ptys } = makeManager({ checkSignedIn: async () => { throw new Error('boom'); } });
    const { attemptId } = manager.start({ cols: 40, rows: 10 });
    ptys[0].emit(`visit https://claude.com/cai/oauth/authorize?code=true&state=${SECRET_CODE}`);
    manager.input(attemptId, 'phone', 1, `${SECRET_CODE}\r`);
    manager.resize(attemptId, { cols: 50, rows: 12 });
    ptys[0].exit(0);
    await flush();

    expect(logCalls.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(logCalls);
    expect(serialized).not.toContain(SECRET_CODE);
    expect(serialized).not.toContain('oauth/authorize');
    expect(ptys[0].size).toEqual({ cols: 50, rows: 12 });
  });
});
