import { execFile } from 'child_process';
import { tmpdir } from 'os';
import { findUserClaudeExecutable } from '../process/claude-cli.js';
import { agentEnv } from './agent-env.js';
import { claudeSpawnEnv } from '../../process-daemon/claude-spawn-auth.js';
import { parseJson } from '../../utils/json.js';
import { createLogger } from './logger.js';

const logger = createLogger('ClaudePlanUsage');

/** One limit the plan reports, e.g. "Current week (Fable): 28% used". */
export interface ClaudePlanLimit {
  /** `session` is the short rolling window; `week` the weekly allowance. */
  window: 'session' | 'week' | 'other';
  /** What the limit covers: "all models", a model family such as "Fable", or null when the CLI names none. */
  scope: string | null;
  percentUsed: number;
  /** The reset as the CLI words it, e.g. "Nov 27 at 2:59am (Europe/London)". */
  resets: string | null;
}

export type ClaudePlanUsage =
  | { state: 'ok'; limits: ClaudePlanLimit[]; checkedAt: number }
  | { state: 'unavailable'; reason: string; checkedAt: number };

const LIMIT_LINE = /^Current ([^:(]+?)(?:\s*\(([^)]+)\))?:\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+))?$/;

/** Reads the limit lines out of the text `claude -p /usage` prints. */
export function parseClaudeUsageText(text: string): ClaudePlanLimit[] {
  const limits: ClaudePlanLimit[] = [];
  for (const raw of text.split('\n')) {
    const match = LIMIT_LINE.exec(raw.trim());
    if (!match) continue;
    const name = match[1].trim().toLowerCase();
    limits.push({
      window: name === 'session' ? 'session' : name === 'week' ? 'week' : 'other',
      scope: match[2]?.trim() ?? null,
      percentUsed: Number(match[3]),
      resets: match[4]?.trim() ?? null,
    });
  }
  return limits;
}

const FRESH_MS = 10 * 60_000;
const RUN_TIMEOUT_MS = 60_000;

type Runner = () => Promise<string>;

/** Runs the user's Claude Code `/usage` command; it reads the plan server-side and spends no tokens. */
const runUsageCommand: Runner = () => new Promise((resolve, reject) => {
  const claude = findUserClaudeExecutable();
  if (!claude) { reject(new Error('Claude Code is not installed')); return; }
  execFile(
    claude,
    ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'],
    { cwd: tmpdir(), timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { ...agentEnv(), ...claudeSpawnEnv(undefined) } },
    (error, stdout) => (error ? reject(error) : resolve(stdout)),
  );
});

/**
 * Claude plan usage, read through the CLI and kept for ten minutes. A stale
 * reading is returned at once while a new one is fetched, so the header never
 * waits on the CLI after the first read.
 */
export class ClaudePlanUsageService {
  private cached: ClaudePlanUsage | null = null;
  private inflight: Promise<ClaudePlanUsage> | null = null;

  constructor(private readonly run: Runner = runUsageCommand, private readonly now: () => number = Date.now) {}

  async get(): Promise<ClaudePlanUsage> {
    if (this.cached && this.now() - this.cached.checkedAt < FRESH_MS) return this.cached;
    const refresh = this.refresh();
    return this.cached ?? refresh;
  }

  private refresh(): Promise<ClaudePlanUsage> {
    this.inflight ??= this.read().then((usage) => {
      this.cached = usage;
      return usage;
    }).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async read(): Promise<ClaudePlanUsage> {
    const checkedAt = this.now();
    try {
      const output = parseJson(await this.run()) as { result?: unknown; is_error?: unknown };
      const text = typeof output.result === 'string' ? output.result : '';
      const limits = parseClaudeUsageText(text);
      if (output.is_error === true || limits.length === 0) {
        return { state: 'unavailable', reason: text.split('\n')[0]?.trim() || 'Claude Code reported no plan limits', checkedAt };
      }
      return { state: 'ok', limits, checkedAt };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn('Could not read Claude plan usage', { reason });
      return { state: 'unavailable', reason, checkedAt };
    }
  }
}

export const claudePlanUsage = new ClaudePlanUsageService();
