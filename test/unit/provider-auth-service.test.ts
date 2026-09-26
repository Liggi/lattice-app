import { describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const shutdownAllCodexAppServerClients = vi.fn();
vi.mock('../../src/services/process/codex-app-server-client.js', () => ({
  shutdownAllCodexAppServerClients: () => shutdownAllCodexAppServerClients(),
}));

import {
  ProviderAuthService,
  extractCodexDeviceLogin,
  type ClaudeCli,
  type CodexLoginHandle,
  type CommandRunner,
} from '../../src/services/provider-auth-service.js';

const TEST_CLI: ClaudeCli = { path: '/usr/local/bin/claude', version: '2.1.278 (Claude Code)' };
const resolvesTestCli = async (): Promise<ClaudeCli> => TEST_CLI;

function result(
  stdout = '',
  exitCode = 0,
  stderr = ''
): Awaited<ReturnType<CommandRunner>> {
  return { stdout, stderr, exitCode, signal: null };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; });
  return { promise, resolve };
}

function fakeLogin(): {
  handle: CodexLoginHandle;
  emit: (chunk: string) => void;
  exit: (exitCode: number) => void;
} {
  const listeners = new Set<(chunk: string) => void>();
  const exited = deferred<{ exitCode: number | null; signal: string | null }>();
  return {
    handle: {
      kill: vi.fn(),
      onOutput: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      exited: exited.promise,
    },
    emit: (chunk) => { for (const listener of listeners) listener(chunk); },
    exit: (exitCode) => exited.resolve({ exitCode, signal: null }),
  };
}

describe('Claude CLI resolution', () => {
  function cliDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-claude-cli-'));
    const path = join(dir, 'claude');
    writeFileSync(path, '#!/bin/sh\nexit 0\n');
    chmodSync(path, 0o755);
    return dir;
  }

  async function withPath<T>(value: string, run: () => Promise<T>): Promise<T> {
    const original = process.env.PATH;
    process.env.PATH = value;
    try {
      return await run();
    } finally {
      process.env.PATH = original;
    }
  }

  it('selects the user-installed CLI explicitly, by path, for status as well as login', async () => {
    const dir = cliDir();
    const commandRunner = vi.fn<CommandRunner>(async () => result('2.1.278 (Claude Code)'));
    const service = new ProviderAuthService({ commandRunner });

    try {
      await withPath(dir, async () => {
        await expect(service.resolveClaudeCli()).resolves.toEqual({
          path: join(dir, 'claude'),
          version: '2.1.278 (Claude Code)',
        });
        await service.getClaudeAuthStatus();
      });
      expect(commandRunner).toHaveBeenCalledWith(join(dir, 'claude'), ['auth', 'status', '--json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports that no CLI was found rather than falling back to whatever `claude` resolves to', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'lattice-no-cli-'));
    const commandRunner = vi.fn<CommandRunner>(async () => result('{}'));
    const service = new ProviderAuthService({ commandRunner });

    try {
      const status = await withPath(empty, () => service.getClaudeAuthStatus());
      expect(status).toEqual({
        available: false,
        installed: false,
        error: 'No Claude Code CLI found on PATH outside this workspace. Install Claude Code.',
      });
      expect(commandRunner).not.toHaveBeenCalled();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('uses the same resolved binary for status and logout', async () => {
    const service = new ProviderAuthService({
      claudeCliResolver: resolvesTestCli,
      commandRunner: vi.fn<CommandRunner>(async () => result('{}')),
    });

    await service.getClaudeAuthStatus();
    await service.logoutClaude();

    const service2 = service as unknown as { commandRunner: ReturnType<typeof vi.fn> };
    expect(service2.commandRunner.mock.calls.map((call) => call[0])).toEqual([TEST_CLI.path, TEST_CLI.path]);
  });
});

const CODEX_DEVICE_OUTPUT =
  'Welcome to Codex [v\u001b[90m0.153.3\u001b[0m]\n\n'
  + 'Follow these steps to sign in with ChatGPT using device code authorization:\n\n'
  + '1. Open this link in your browser and sign in to your account\n'
  + '   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n'
  + '2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n'
  + '   \u001b[94mUZFQ-R0O1X\u001b[0m\n';

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('ProviderAuthService Codex device login', () => {
  it('parses the device URL and one-time code out of ANSI-coloured CLI output', () => {
    expect(extractCodexDeviceLogin(CODEX_DEVICE_OUTPUT)).toEqual({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'UZFQ-R0O1X',
    });
    expect(extractCodexDeviceLogin('Welcome to Codex\n')).toBeNull();
  });

  it('reports pending until the CLI exits, then verifies status and retires app-servers', async () => {
    shutdownAllCodexAppServerClients.mockClear();
    const login = fakeLogin();
    const commandRunner = vi.fn<CommandRunner>(async (command, args) => {
      expect([command, ...args]).toEqual(['codex', 'login', 'status']);
      return result('', 0, 'Logged in using ChatGPT\n');
    });
    const service = new ProviderAuthService({
      codexLoginFactory: () => login.handle,
      commandRunner,
    });

    const starting = service.startCodexDeviceLogin();
    login.emit(CODEX_DEVICE_OUTPUT);
    const session = await starting;
    expect(session.verificationUrl).toBe('https://auth.openai.com/codex/device');
    expect(session.userCode).toBe('UZFQ-R0O1X');
    expect(service.getCodexDeviceLoginState(session.sessionId)).toEqual({ state: 'pending' });

    login.exit(0);
    await settle();

    expect(service.getCodexDeviceLoginState(session.sessionId)).toEqual({ state: 'success' });
    expect(shutdownAllCodexAppServerClients).toHaveBeenCalledTimes(1);
    // Terminal states are handed out once; the session is gone afterwards.
    expect(service.getCodexDeviceLoginState(session.sessionId)).toBeNull();
  });

  it('surfaces the CLI error line when the device login fails', async () => {
    shutdownAllCodexAppServerClients.mockClear();
    const login = fakeLogin();
    const service = new ProviderAuthService({
      codexLoginFactory: () => login.handle,
      commandRunner: vi.fn<CommandRunner>(async () => result('', 1, 'Not logged in\n')),
    });

    const starting = service.startCodexDeviceLogin();
    login.emit(CODEX_DEVICE_OUTPUT);
    const session = await starting;
    login.emit('Error logging in with device code: device code expired\n');
    login.exit(1);
    await settle();

    expect(service.getCodexDeviceLoginState(session.sessionId)).toEqual({
      state: 'failed',
      error: 'Error logging in with device code: device code expired',
    });
    expect(shutdownAllCodexAppServerClients).not.toHaveBeenCalled();
  });

  it('does not report success when the CLI exits cleanly but status still says logged out', async () => {
    const login = fakeLogin();
    const service = new ProviderAuthService({
      codexLoginFactory: () => login.handle,
      commandRunner: vi.fn<CommandRunner>(async () => result('', 1, 'Not logged in\n')),
    });

    const starting = service.startCodexDeviceLogin();
    login.emit(CODEX_DEVICE_OUTPUT);
    const session = await starting;
    login.exit(0);
    await settle();

    expect(service.getCodexDeviceLoginState(session.sessionId)).toEqual({
      state: 'failed',
      error: 'Codex login completed, but Codex still reports that it is not logged in',
    });
  });

  it('reads login status from the exit code and retires app-servers on logout', async () => {
    shutdownAllCodexAppServerClients.mockClear();
    const commandRunner = vi.fn<CommandRunner>(async (_command, args) => (
      args[0] === 'logout' ? result('', 0, 'Successfully logged out\n') : result('', 1, 'Not logged in\n')
    ));
    const service = new ProviderAuthService({ commandRunner });

    await expect(service.getCodexAuthStatus()).resolves.toEqual({
      available: true,
      installed: true,
      loggedIn: false,
      detail: 'Not logged in',
    });
    await expect(service.logoutCodex()).resolves.toMatchObject({ success: true, exitCode: 0 });
    expect(shutdownAllCodexAppServerClients).toHaveBeenCalledTimes(1);
  });

  it('tells a Codex that is not installed apart from one that failed to run', async () => {
    const missing = new ProviderAuthService({
      commandRunner: async () => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }); },
    });
    await expect(missing.getCodexAuthStatus()).resolves.toMatchObject({ available: false, installed: false });

    const broken = new ProviderAuthService({
      commandRunner: async () => { throw Object.assign(new Error('spawn codex EACCES'), { code: 'EACCES' }); },
    });
    await expect(broken.getCodexAuthStatus()).resolves.toMatchObject({ available: false, installed: true });
  });
});
