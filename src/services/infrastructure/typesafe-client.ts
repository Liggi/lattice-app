/**
 * TypeSafe's Jev: a criterion judge. Questions against a state, answered
 * as a probability (noul), a level (score) or one of a set (choice). Called direct (`api.typesafe.ai`) rather than
 * through a gateway: the Vercel gateway was returning 503s on 2026-09-19
 * while the direct endpoint answered in ~340ms median.
 *
 * The key is resolved on every call (config, env, or a file named in
 * config) and is never logged or included in an error; a response that
 * echoes it is refused rather than returned.
 */

import { readFileSync } from 'node:fs';
import { parseJson } from '../../utils/json.js';
import type { LLMOperationType } from '../insights/insight-types.js';
import { ConfigService } from './config-service.js';
import { getCostTracker } from './cost-tracker.js';
import { createLogger } from './logger.js';

const logger = createLogger('TypeSafeClient');

export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';

export interface NoulQuestion {
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface NoulAnswer {
  /** Probability the criterion holds, 0..1. */
  noul: number;
  /** Model the service resolved `jev-latest` to. */
  model: string;
  ms: number;
}

export class TypeSafeUnavailableError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'TypeSafeUnavailableError';
  }
}

/** The key, or null when nothing is configured. Never logged. */
export function resolveTypeSafeKey(): string | null {
  let config: ReturnType<ConfigService['getConfig']> | null = null;
  try {
    config = ConfigService.getInstance().getConfig();
  } catch {
    config = null;
  }
  const direct = config?.typesafe?.apiKey?.trim() || process.env.TYPESAFE_API_KEY?.trim();
  if (direct) return direct;
  const file = config?.typesafe?.apiKeyFile?.trim();
  if (!file) return null;
  try {
    const key = readFileSync(file, 'utf8').trim();
    return key || null;
  } catch (err) {
    logger.warn('TypeSafe key file unreadable', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export function isTypeSafeConfigured(): boolean {
  return resolveTypeSafeKey() !== null;
}

export interface JudgeOptions {
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** Recorded in `llm_costs` with the call's token usage. */
  cost?: { operation: LLMOperationType; sessionId: string };
}

/**
 * Ask Jev one noul question. Throws `TypeSafeUnavailableError` when the key
 * is missing, the call times out, or the service answers anything but 200
 * after one retry on 429/529; the caller treats every failure the same way
 * (no route), so the distinctions only matter for the log.
 */
export async function judgeNoul(
  state: string,
  question: NoulQuestion,
  options: JudgeOptions = { timeoutMs: 3000 },
): Promise<NoulAnswer> {
  const answer = await judgeNouls(state, { q: question }, options);
  return { noul: answer.nouls.q, model: answer.model, ms: answer.ms };
}

/** Several noul questions against one state in a single call, keyed as asked. Fails as `judgeNoul` does. */
export async function judgeNouls<K extends string>(
  state: string,
  questions: Record<K, NoulQuestion>,
  options: JudgeOptions = { timeoutMs: 3000 },
): Promise<{ nouls: Record<K, number>; model: string; ms: number }> {
  const keys = Object.keys(questions) as K[];
  const asked = Object.fromEntries(keys.map((k) => [k, { type: 'noul' as const, ...questions[k] }])) as Record<K, JevQuestion>;
  const { answers, model, ms } = await askJev(state, asked, options);
  const nouls = {} as Record<K, number>;
  for (const k of keys) nouls[k] = answers[k].noul as number;
  return { nouls, model, ms };
}

/**
 * Jev's three question types. `instructions` may be a string or an object
 * whose fields name parts of the state, as `idea` and `explanation` do in
 * the explain-back check.
 */
export type JevQuestion =
  | { type: 'noul'; instructions: unknown; criteria?: { true: string; false: string } }
  | { type: 'score'; instructions: unknown; criteria: string[] }
  | { type: 'choice'; instructions: unknown; criteria: Record<string, string> };

export interface JevAnswer {
  /** Noul: probability the criterion holds, 0..1. */
  noul?: number;
  /** Score: expected level, 0..levels-1. */
  score?: number;
  /** Choice: the key of the chosen option. */
  choice?: string;
  confidence?: number;
  probabilities?: number[] | Record<string, number>;
}

export interface AskJevOptions extends JudgeOptions {
  /** A pinned version (`jev-1.13.0`); `jev-latest` when absent. */
  model?: string;
}

/**
 * Any mix of Jev questions against one state in a single call, keyed as
 * asked. Each answer is checked for the field its type returns. Fails as
 * `judgeNoul` does.
 */
export async function askJev<K extends string>(
  state: unknown,
  questions: Record<K, JevQuestion>,
  options: AskJevOptions = { timeoutMs: 3000 },
): Promise<{ answers: Record<K, JevAnswer>; model: string; ms: number }> {
  const key = resolveTypeSafeKey();
  if (!key) throw new TypeSafeUnavailableError('TypeSafe key not configured');
  const doFetch = options.fetchImpl ?? fetch;
  const requestedModel = options.model ?? JEV_MODEL;
  const keys = Object.keys(questions) as K[];
  const body = JSON.stringify({ model: requestedModel, state, questions });
  const started = Date.now();
  const deadline = started + options.timeoutMs;

  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new TypeSafeUnavailableError('TypeSafe call timed out');
    let res: Response;
    try {
      res = await doFetch(TYPESAFE_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(remaining),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new TypeSafeUnavailableError(`TypeSafe call failed: ${message}`);
    }
    const text = await res.text();
    if (text.includes(key)) throw new TypeSafeUnavailableError('TypeSafe response echoed the credential; refused');
    if ((res.status === 429 || res.status === 529) && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(300, Math.max(0, deadline - Date.now()))));
      continue;
    }
    if (!res.ok) throw new TypeSafeUnavailableError(`TypeSafe answered ${res.status}`, res.status);
    let parsed: unknown;
    try {
      parsed = parseJson(text);
    } catch {
      throw new TypeSafeUnavailableError('TypeSafe answered with malformed JSON');
    }
    const answer = (parsed ?? {}) as {
      model?: unknown;
      answers?: Record<string, JevAnswer | undefined>;
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    const answers = {} as Record<K, JevAnswer>;
    for (const k of keys) {
      const got = answer.answers?.[k];
      if (!got || !hasAnswerFor(questions[k], got)) throw new TypeSafeUnavailableError(`TypeSafe answer had no ${questions[k].type} for ${k}`);
      answers[k] = got;
    }
    const ms = Date.now() - started;
    const model = typeof answer.model === 'string' ? answer.model : requestedModel;
    logJevCost(answer.usage, options.cost, ms, model);
    return { answers, model, ms };
  }
}

function hasAnswerFor(question: JevQuestion, got: JevAnswer): boolean {
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  if (question.type === 'noul') return finite(got.noul) && got.noul >= 0 && got.noul <= 1;
  if (question.type === 'score') return finite(got.score) && got.score >= 0 && got.score <= question.criteria.length - 1;
  return typeof got.choice === 'string' && got.choice in question.criteria;
}

/** Jev bills per token like any model; without this its spend never reached the cost log. */
function logJevCost(
  usage: { input_tokens?: unknown; output_tokens?: unknown } | undefined,
  cost: JudgeOptions['cost'],
  durationMs: number,
  model: string,
): void {
  const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
  try {
    getCostTracker().log({
      sessionId: cost?.sessionId ?? 'typesafe',
      operation: cost?.operation ?? 'NEEDS_YOU',
      model,
      inputTokens: count(usage?.input_tokens),
      outputTokens: count(usage?.output_tokens),
      durationMs,
      provider: 'typesafe',
    });
  } catch {
    // Ledger unavailable; the judgement still returns.
  }
}
