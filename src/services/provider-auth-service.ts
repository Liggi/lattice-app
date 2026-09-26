import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { createLogger } from './infrastructure/logger.js';
import { parseJson } from '../utils/json.js';
import { shutdownAllCodexAppServerClients } from './process/codex-app-server-client.js';
import { findUserClaudeExecutable } from './process/claude-cli.js';

const logger = createLogger('ProviderAuthService');

// Codex's device code expires 15 minutes after it is issued; keep the waiting
// process around for the whole window so a slow phone sign-in still lands.
const CODEX_DEVICE_LOGIN_TTL_MS = 16 * 60 * 1000;
const CODEX_DEVICE_URL_PATTERN = /https:\/\/[^\s]+\/device[^\s]*/;
const CODEX_DEVICE_CODE_PATTERN = /\b([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/;
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

const STATUS_COMMAND_TIMEOUT_MS = 5_000;
const LOGIN_START_TIMEOUT_MS = 15_000;

export interface CodexLoginHandle {
  kill(): void;
  onOutput(listener: (chunk: string) => void): () => void;
  exited: Promise<{ exitCode: number | null; signal: string | null }>;
}

export type CodexDeviceLoginState =
  | { state: 'pending' }
  | { state: 'success' }
  | { state: 'failed'; error: string };

interface CodexDeviceLoginSession {
  login: CodexLoginHandle;
  verificationUrl: string;
  userCode: string;
  createdAt: number;
  unsubscribe: () => void;
  captured: { output: string };
  result: CodexDeviceLoginState;
}

async function runCommand(
  command: string,
  args: string[],
  options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null }> {
  const timeoutMs = options?.timeoutMs ?? STATUS_COMMAND_TIMEOUT_MS;
  const env = options?.env ?? process.env;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch (_e) {}
      resolve({ stdout, stderr, exitCode: null, signal: 'timeout' });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, signal });
    });
  });
}

type CommandResult = Awaited<ReturnType<typeof runCommand>>;

/** A CLI that is not on PATH, as opposed to one that ran and failed. */
function isNotInstalled(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}
export type CommandRunner = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }
) => Promise<CommandResult>;

export interface ProviderAuthServiceOptions {
  commandRunner?: CommandRunner;
  claudeCliResolver?: () => Promise<ClaudeCli>;
  codexLoginFactory?: () => CodexLoginHandle;
}

/** Claude CLI chosen for auth work, named in errors so a bad one is obvious. */
export interface ClaudeCli {
  path: string;
  version: string;
}

export function describeClaudeCli(cli: ClaudeCli): string {
  return `${cli.path} (${cli.version})`;
}

/**
 * Pulls the sign-in URL and one-time code out of `codex login --device-auth`
 * output. Both are printed once the device code is issued; the process then
 * polls OpenAI until the user finishes in a browser.
 */
export function extractCodexDeviceLogin(output: string): { verificationUrl: string; userCode: string } | null {
  const plain = output.replace(ANSI_PATTERN, '');
  const verificationUrl = plain.match(CODEX_DEVICE_URL_PATTERN)?.[0];
  if (!verificationUrl) return null;
  const afterUrl = plain.slice(plain.indexOf(verificationUrl) + verificationUrl.length);
  const userCode = afterUrl.match(CODEX_DEVICE_CODE_PATTERN)?.[1];
  return userCode ? { verificationUrl, userCode } : null;
}

function spawnLoginProcess(command: string, args: string[]): CodexLoginHandle {
  const child = spawn(command, args, {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const listeners = new Set<(chunk: string) => void>();
  const emit = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    for (const listener of listeners) listener(text);
  };
  child.stdout.on('data', emit);
  child.stderr.on('data', emit);

  const exited = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });

  return {
    kill: () => { child.kill('SIGTERM'); },
    onOutput: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    exited,
  };
}

function createCodexLoginHandle(): CodexLoginHandle {
  return spawnLoginProcess('codex', ['login', '--device-auth']);
}

function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref();
  });
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ProviderAuthService {
  private codexDeviceLogins = new Map<string, CodexDeviceLoginSession>();
  private readonly commandRunner: CommandRunner;
  private readonly claudeCliResolver: () => Promise<ClaudeCli>;
  private readonly codexLoginFactory: () => CodexLoginHandle;
  private resolvedClaudeCli: ClaudeCli | null = null;

  constructor(options: ProviderAuthServiceOptions = {}) {
    this.commandRunner = options.commandRunner ?? runCommand;
    this.claudeCliResolver = options.claudeCliResolver ?? (() => this.selectClaudeCli());
    this.codexLoginFactory = options.codexLoginFactory ?? createCodexLoginHandle;
  }

  /**
   * The user's Claude Code, named explicitly. Every auth operation runs this
   * one binary, so a session is reported and revoked by the CLI that created
   * it. There is no fallback to a bare `claude`: that is the ambiguous
   * selection this exists to replace, and a failure to find one is worth
   * reading. Resolution is kept once it succeeds; a failure stays unresolved
   * so installing a CLI takes effect without a restart.
   */
  async resolveClaudeCli(): Promise<ClaudeCli> {
    if (!this.resolvedClaudeCli) {
      this.resolvedClaudeCli = await this.claudeCliResolver();
    }
    return this.resolvedClaudeCli;
  }

  private async selectClaudeCli(): Promise<ClaudeCli> {
    const path = findUserClaudeExecutable();
    if (!path) {
      throw Object.assign(
        new Error('No Claude Code CLI found on PATH outside this workspace. Install Claude Code.'),
        { code: 'ENOENT' },
      );
    }
    const version = (await this.commandRunner(path, ['--version'])).stdout.trim() || 'unknown version';
    return { path, version };
  }

  // -----------------------------------------------------------------------
  // Codex device-code flow
  // -----------------------------------------------------------------------

  /**
   * Starts `codex login --device-auth` and returns the URL + one-time code the
   * user enters in a browser. Unlike Claude's flow nothing comes back to
   * paste: the CLI polls OpenAI itself, so the client polls
   * `getCodexDeviceLoginState` until the process exits.
   */
  async startCodexDeviceLogin(): Promise<{ sessionId: string; verificationUrl: string; userCode: string }> {
    // Codex clears the stored credentials when a login starts, so two waiting
    // processes would invalidate each other. Keep only the newest.
    for (const [id, session] of this.codexDeviceLogins) {
      if (session.result.state === 'pending') {
        session.unsubscribe();
        session.login.kill();
      }
      this.codexDeviceLogins.delete(id);
    }

    const sessionId = randomUUID();
    const login = this.codexLoginFactory();
    const captured = { output: '' };
    let resolvePrompt!: (details: { verificationUrl: string; userCode: string }) => void;
    const promptReady = new Promise<{ verificationUrl: string; userCode: string }>((resolve) => { resolvePrompt = resolve; });
    const unsubscribe = login.onOutput((chunk) => {
      captured.output += chunk;
      const details = extractCodexDeviceLogin(captured.output);
      if (details) resolvePrompt(details);
    });

    try {
      const details = await Promise.race([
        promptReady,
        login.exited.then(({ exitCode, signal }) => {
          throw new Error(`Codex login exited before presenting a device code (code=${exitCode}, signal=${signal}): ${captured.output.replace(ANSI_PATTERN, '').trim()}`);
        }),
        rejectAfter(LOGIN_START_TIMEOUT_MS, 'Codex login did not present a device code in time'),
      ]);

      const session: CodexDeviceLoginSession = {
        login,
        verificationUrl: details.verificationUrl,
        userCode: details.userCode,
        createdAt: Date.now(),
        unsubscribe,
        captured,
        result: { state: 'pending' },
      };
      this.codexDeviceLogins.set(sessionId, session);

      void login.exited.then(async ({ exitCode, signal }) => {
        session.unsubscribe();
        if (session.result.state !== 'pending') return;
        if (exitCode !== 0) {
          const tail = session.captured.output.replace(ANSI_PATTERN, '').trim().split('\n').at(-1) ?? '';
          session.result = {
            state: 'failed',
            error: tail || `Codex login failed (code=${exitCode}, signal=${signal})`,
          };
          logger.warn('Codex device login failed', { sessionId, exitCode, signal, tail });
          return;
        }
        const status = await this.getCodexAuthStatus();
        if (!status.loggedIn) {
          session.result = {
            state: 'failed',
            error: 'Codex login completed, but Codex still reports that it is not logged in',
          };
          return;
        }
        session.result = { state: 'success' };
        logger.info('Codex device login succeeded', { sessionId });
        // A running app-server only re-reads auth.json when a login goes
        // through it; ours went through the CLI, so retire the servers and let
        // the next thread spawn fresh ones that see the new credentials.
        shutdownAllCodexAppServerClients();
      });

      setTimeout(() => {
        const current = this.codexDeviceLogins.get(sessionId);
        if (!current) return;
        current.unsubscribe();
        current.login.kill();
        this.codexDeviceLogins.delete(sessionId);
      }, CODEX_DEVICE_LOGIN_TTL_MS).unref();

      logger.info('Codex device login started', { sessionId });
      return { sessionId, verificationUrl: details.verificationUrl, userCode: details.userCode };
    } catch (error) {
      unsubscribe();
      login.kill();
      throw error;
    }
  }

  getCodexDeviceLoginState(sessionId: string): CodexDeviceLoginState | null {
    const session = this.codexDeviceLogins.get(sessionId);
    if (!session) return null;
    if (session.result.state !== 'pending') {
      this.codexDeviceLogins.delete(sessionId);
    }
    return session.result;
  }

  cancelCodexDeviceLogin(sessionId: string): boolean {
    const session = this.codexDeviceLogins.get(sessionId);
    if (!session) return false;
    session.unsubscribe();
    session.login.kill();
    this.codexDeviceLogins.delete(sessionId);
    return true;
  }

  async getCodexAuthStatus(): Promise<{ available: boolean; installed: boolean; loggedIn: boolean; detail: string }> {
    try {
      // Exit 0 = logged in; the human-readable line is on stderr either way.
      const result = await this.commandRunner('codex', ['login', 'status']);
      const detail = (result.stderr.trim() || result.stdout.trim()).split('\n').at(-1) ?? '';
      return { available: true, installed: true, loggedIn: result.exitCode === 0, detail };
    } catch (error) {
      return {
        available: false,
        installed: !isNotInstalled(error),
        loggedIn: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async logoutCodex(): Promise<{ success: boolean; exitCode?: number | null; stderr?: string; error?: string }> {
    try {
      const result = await this.commandRunner('codex', ['logout'], { timeoutMs: 10_000 });
      // Servers spawned under the old credentials keep them cached in memory.
      shutdownAllCodexAppServerClients();
      return { success: true, exitCode: result.exitCode, stderr: result.stderr.trim() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async writeGitCredentials(token: string, login: string, email: string): Promise<void> {
    const credentialsPath = join(homedir(), '.git-credentials');
    const encodedLogin = encodeURIComponent(login);
    const encodedToken = encodeURIComponent(token);
    const credentialLine = `https://${encodedLogin}:${encodedToken}@github.com\n`;
    writeFileSync(credentialsPath, credentialLine, { encoding: 'utf8' });
    chmodSync(credentialsPath, 0o600);

    await this.configureGitIdentity(login, email);

    // Set GH_TOKEN/GITHUB_TOKEN in current process so spawned Claude sessions inherit it
    process.env.GH_TOKEN = token;
    process.env.GITHUB_TOKEN = token;

    // Configure gh CLI auth (if gh is available)
    try {
      const result = await runCommand('sh', ['-c', `echo "${token}" | gh auth login --with-token`], {
        timeoutMs: 10_000,
        env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
      });
      if (result.exitCode === 0) {
        logger.info('gh CLI authenticated', { login });
      } else {
        logger.warn('gh auth login failed (gh may not be installed)', { stderr: result.stderr.trim().slice(0, 200) });
      }
    } catch {
      logger.warn('gh CLI not available, skipping gh auth');
    }

    // Persist GH_TOKEN in .bashrc so future shells inherit it
    const bashrcPath = join(homedir(), '.bashrc');
    try {
      let bashrc = '';
      try {
        bashrc = readFileSync(bashrcPath, 'utf8');
      } catch {
        // no .bashrc yet
      }
      const marker = '# lattice-github-token';
      const exportLine = `export GH_TOKEN="${token}" GITHUB_TOKEN="${token}" ${marker}`;
      if (bashrc.includes(marker)) {
        bashrc = bashrc.replace(/^.*# lattice-github-token.*$/m, exportLine);
      } else {
        bashrc = bashrc.trimEnd() + '\n' + exportLine + '\n';
      }
      writeFileSync(bashrcPath, bashrc, { encoding: 'utf8' });
    } catch (err) {
      logger.warn('Failed to update .bashrc with GH_TOKEN', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // -----------------------------------------------------------------------
  // Auth status & logout
  // -----------------------------------------------------------------------

  async getClaudeAuthStatus(): Promise<{
    available: boolean;
    installed: boolean;
    exitCode?: number | null;
    signal?: string | null;
    status?: unknown;
    error?: string;
  }> {
    try {
      const result = await this.commandRunner((await this.resolveClaudeCli()).path, ['auth', 'status', '--json']);
      const stdout = result.stdout.trim();
      let parsed: unknown = null;
      try {
        parsed = stdout ? (parseJson(stdout) as unknown) : null;
      } catch {
        parsed = null;
      }
      return {
        available: true,
        installed: true,
        exitCode: result.exitCode,
        signal: result.signal,
        status: parsed ?? { raw: stdout, stderr: result.stderr.trim() },
      };
    } catch (error) {
      return {
        available: false,
        installed: !isNotInstalled(error),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async logoutClaude(): Promise<{ success: boolean; exitCode?: number | null; stderr?: string; error?: string }> {
    try {
      const result = await this.commandRunner((await this.resolveClaudeCli()).path, ['auth', 'logout'], { timeoutMs: 10_000 });
      return { success: true, exitCode: result.exitCode, stderr: result.stderr.trim() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private async configureGitIdentity(login: string, email: string): Promise<void> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homedir(),
    };

    const commands: string[][] = [
      ['config', '--global', 'credential.helper', 'store'],
      ['config', '--global', 'user.name', login],
      ['config', '--global', 'user.email', email],
    ];

    for (const args of commands) {
      const result = await runCommand('git', args, {
        timeoutMs: 10_000,
        env,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `git ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim().slice(0, 300)}`
        );
      }
    }
  }
}

// Singleton
let _instance: ProviderAuthService | null = null;
export function getProviderAuthService(): ProviderAuthService {
  if (!_instance) {
    _instance = new ProviderAuthService();
  }
  return _instance;
}
