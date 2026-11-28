import { execFile } from 'child_process';
import { tmpdir } from 'os';
import { agyBinary } from '../../harness/antigravity-process-adapter.js';
import { agentEnv } from './agent-env.js';
import { parseJson } from '../../utils/json.js';
import { createLogger } from './logger.js';

const logger = createLogger('GeminiPlanUsage');

/** One limit `agy /usage` reports, e.g. the Gemini Models weekly limit. */
export interface GeminiPlanLimit {
  id: string;
  /** The model group the limit covers, e.g. "Gemini Models" or "Claude and GPT models". */
  group: string;
  window: 'week' | '5h' | 'other';
  percentUsed: number;
  /** Epoch ms of the reset, or null when agy reports none (it sends 1970 for an unused group). */
  resetAt: number | null;
}

export type GeminiPlanUsage =
  | { state: 'ok'; limits: GeminiPlanLimit[]; checkedAt: number }
  | { state: 'unavailable'; reason: string; checkedAt: number };

interface AgyBucket { id?: unknown; window?: unknown; remaining_fraction?: unknown; reset_time?: unknown }
interface AgyUsageOutput {
  status?: unknown;
  response?: unknown;
  command?: { data?: { groups?: Array<{ name?: unknown; buckets?: AgyBucket[] }> } };
}

function resetAt(value: unknown): number | null {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at > 0 ? at : null;
}

/** Reads the limits out of the JSON `agy -p /usage --output-format json` prints. */
export function parseAgyUsage(output: AgyUsageOutput): GeminiPlanLimit[] {
  const limits: GeminiPlanLimit[] = [];
  for (const group of output.command?.data?.groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      if (typeof bucket.remaining_fraction !== 'number' || !Number.isFinite(bucket.remaining_fraction)) continue;
      limits.push({
        id: typeof bucket.id === 'string' ? bucket.id : '',
        group: typeof group.name === 'string' ? group.name : '',
        window: bucket.window === 'weekly' ? 'week' : bucket.window === '5h' ? '5h' : 'other',
        percentUsed: Math.min(100, Math.max(0, Math.round((1 - bucket.remaining_fraction) * 100))),
        resetAt: resetAt(bucket.reset_time),
      });
    }
  }
  return limits;
}

const FRESH_MS = 10 * 60_000;
const RUN_TIMEOUT_MS = 30_000;

type Runner = () => Promise<string>;

/** Runs agy's `/usage` command; it reads the plan's quota and spends no tokens. */
const runUsageCommand: Runner = () => new Promise((resolve, reject) => {
  execFile(
    agyBinary(),
    ['-p', '/usage', '--output-format', 'json'],
    { cwd: tmpdir(), timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: agentEnv() },
    (error, stdout) => (error ? reject(error) : resolve(stdout)),
  );
});

/**
 * Gemini plan usage, read through agy and kept for ten minutes. A stale
 * reading is returned at once while a new one is fetched.
 */
export class GeminiPlanUsageService {
  private cached: GeminiPlanUsage | null = null;
  private inflight: Promise<GeminiPlanUsage> | null = null;

  constructor(private readonly run: Runner = runUsageCommand, private readonly now: () => number = Date.now) {}

  async get(): Promise<GeminiPlanUsage> {
    if (this.cached && this.now() - this.cached.checkedAt < FRESH_MS) return this.cached;
    const refresh = this.refresh();
    return this.cached ?? refresh;
  }

  private refresh(): Promise<GeminiPlanUsage> {
    this.inflight ??= this.read().then((usage) => {
      this.cached = usage;
      return usage;
    }).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async read(): Promise<GeminiPlanUsage> {
    const checkedAt = this.now();
    try {
      const output = (parseJson(await this.run()) ?? {}) as AgyUsageOutput;
      const limits = parseAgyUsage(output);
      if (output.status !== 'SUCCESS' || limits.length === 0) {
        const said = typeof output.response === 'string' ? output.response.split('\n')[0]?.trim() : '';
        return { state: 'unavailable', reason: said || 'agy reported no plan limits', checkedAt };
      }
      return { state: 'ok', limits, checkedAt };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn('Could not read Gemini plan usage', { reason });
      return { state: 'unavailable', reason, checkedAt };
    }
  }
}

export const geminiPlanUsage = new GeminiPlanUsageService();
