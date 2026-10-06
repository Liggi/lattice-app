import Anthropic from '@anthropic-ai/sdk';
import { EventEmitter } from 'events';
import {
  LatticeError,
  type SessionContext,
  type SessionTags,
  type AnthropicHealthResponse,
} from '@/types/index.js';
import { createLogger, type Logger } from '@/services/infrastructure/logger.js';
import { ConfigService } from '../infrastructure/config-service.js';
import type { BackgroundJob } from '@/types/config.js';
import { anthropicClientFactory } from '../infrastructure/anthropic-client-factory.js';
import { backgroundTextClient, backgroundProvenance, backgroundUsesPlan, type BackgroundTextClient } from '../infrastructure/background-text-client.js';
import { getCostTracker } from '../infrastructure/cost-tracker.js';
import type { LLMOperationType } from './insight-types.js';
import { parseJson } from '../../utils/json.js';
import { unsupportedDetails } from './human-input.js';
import {
  SESSION_CATEGORIES,
  SESSION_CATEGORY_DEFINITIONS,
  isSessionCategory,
  type SessionCategorySet,
} from '@/types/session-categories.js';

// Return type for extractSessionInsights - the core fields extracted from conversation
export interface ExtractedInsights {
  /** Null when the model said the user's messages do not show what the session is for. */
  context: SessionContext | null;
  theme: string;
  categories: SessionCategorySet | null;
  tags: SessionTags | null;
}

// ============================================================================
// Retry Configuration
// ============================================================================

interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
};

// ============================================================================
// LLM Response Types (for type-safe JSON parsing)
// ============================================================================

interface QuickCheckResponse {
  needsPatch: boolean;
  reason?: string;
}

interface PatchResponse {
  patches?: Record<string, unknown>;
  reason?: string;
}

interface FastPatchResponse {
  purpose?: string;
  [key: string]: unknown;
}

interface MetadataEvalResponse {
  purpose?: string;
  theme?: string;
  tags?: { complexity?: string };
}

/** A mission is a sidebar title: it has to fit one line whole. */
export const MISSION_MAX_CHARS = 54;
const LEADING_MISSION_FILLERS: RegExp[] = [
  /^the (main )?goal (of this session )?is to\s+/i,
  /^our (main )?goal (for this session )?is to\s+/i,
  /^this session (is|was) (about|focused on)\s+/i,
  /^goal:\s+/i,
  /^mission:\s+/i,
  /^objective:\s+/i,
  /^focus(?:ed)? on\s+/i,
  /^work(?:ing)? on\s+/i,
  /^we (?:are|were) (?:working|focusing) on\s+/i,
];

function normalizeMissionCasing(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (!/[a-zA-Z]/.test(char)) {
      continue;
    }

    if (char !== char.toLowerCase()) {
      return value;
    }

    const nextChar = value[index + 1] ?? '';
    if (/[A-Z]/.test(nextChar)) {
      return value;
    }

    return `${value.slice(0, index)}${char.toUpperCase()}${value.slice(index + 1)}`;
  }

  return value;
}

export function normalizeMissionText(mission: string): string {
  const original = mission.trim();
  if (!original) return '';

  let cleaned = original
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  let previous = '';
  while (cleaned !== previous) {
    previous = cleaned;
    for (const pattern of LEADING_MISSION_FILLERS) {
      cleaned = cleaned.replace(pattern, '').trim();
    }
  }

  // Trailing punctuation only. The mission is shown whole: length is the
  // model's job (see `fitMission`), never a cut here.
  cleaned = cleaned.replace(/\s*[.!?]+$/, '').trim();
  return normalizeMissionCasing(cleaned || original);
}

/** A project title has to fit one sidebar line beside a tile and a time. */
export const PROJECT_NAME_MAX_CHARS = 40;

/**
 * The leading verb a name must not start with. The prompt asks for a noun
 * phrase and usually gets one; this is the floor under it, because a name that
 * opens with a verb is the exact failure being corrected — it describes an
 * activity, and activities end while the project does not.
 *
 * Rejecting is deliberate and beats repairing. Stripping "Simplify" from
 * "Simplify the app sidebar" leaves "The app sidebar", which names a component
 * rather than a project. A null falls back to the mission, which is no worse
 * than what shipped before.
 */
const VERB_LED_NAME = /^(add|build|clean|create|deliver|design|develop|drive|enable|ensure|establish|finish|fix|get|give|implement|improve|make|move|own|prioriti[sz]e|prove|refactor|remove|resolve|restore|run|ship|simplify|sort|take|turn|update|verify|work)\b/i;

/**
 * Clean a generated project name, or reject it. Never cuts: a name too long
 * for its line goes back to the model (see `generateProjectName`).
 *
 * Kept separate from the API call so the rules are testable without a client,
 * and separate from `normalizeMissionText` because the two want opposite
 * things: a mission is a phrase about work and may lead with a verb, a project
 * name may not.
 */
export function normalizeProjectName(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*[.!?]+$/, '')
    .trim();

  if (!cleaned) return null;
  // A model that explains itself instead of answering returns a sentence.
  if (cleaned.length > PROJECT_NAME_MAX_CHARS * 2) return null;
  if (VERB_LED_NAME.test(cleaned)) return null;

  return cleaned;
}

/**
 * Determines if an error is retryable (transient network/rate limit issues).
 * Non-retryable: auth errors, credit exhaustion, invalid requests.
 */
export function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const errorName = error instanceof Error ? error.name : '';

  // Non-retryable errors - don't waste retries on these
  // A ChatGPT plan at its usage limit stays there for hours, and once paused it
  // refuses every call locally until someone resumes it in Settings.
  if (message.includes('usage_limit_exceeded')) return false;
  if (message.includes('credit balance') || message.includes('billing')) return false;
  if (message.includes('invalid_api_key') || message.includes('authentication')) return false;
  if (message.includes('invalid_request_error')) return false;

  // Retryable: rate limits, overloaded, server errors, network issues
  if (message.includes('rate_limit') || message.includes('overloaded')) return true;
  if (message.includes('529') || message.includes('503') || message.includes('500')) return true;
  if (errorName === 'APIConnectionError' || message.includes('ECONNRESET')) return true;
  if (errorName === 'RateLimitError' || errorName === 'InternalServerError') return true;

  // Default: retry on unknown errors (might be transient)
  return true;
}

/**
 * Calculates exponential backoff delay with jitter.
 */
function calculateBackoff(attempt: number, config: RetryConfig): number {
  const exponentialDelay = config.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
  return Math.min(exponentialDelay + jitter, config.maxDelayMs);
}

/**
 * Sleep for a specified duration.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Re-export types that other modules import from this file
export type { AnthropicHealthResponse } from '@/types/index.js';

// ============================================================================
// Model Configuration
// ============================================================================
// Centralized model IDs - update these when Anthropic releases new versions.
// These are defaults; can be overridden via config.anthropic.models.*

export const DEFAULT_MODELS = {
  /** Full insight generation - Sonnet balances quality/cost well for structured extraction */
  generation: 'claude-sonnet-5',
  /** Short labels and checks still need the same clarity as report summaries. */
  quickCheck: 'claude-sonnet-5',
  /** Short session-purpose patches. */
  patch: 'claude-sonnet-5',
  /** Full patch generation (fallback) - for complex patches when fast path fails */
  fullPatch: 'claude-sonnet-5',
} as const;

/**
 * Pinned off for every insight call. On the 5-family an OMITTED `thinking`
 * means adaptive thinking is ON (measured 2026-08-28), and the caps in this
 * file (50–500 tokens) were tuned for text output only — adaptive thinking
 * spending them returns empty results with no error. Extraction is
 * classification and short-form writing, so reserve the budget for visible text.
 */
const THINKING: Anthropic.ThinkingConfigParam = { type: 'disabled' };

export class AnthropicService extends EventEmitter {
  private logger: Logger;
  private client: BackgroundTextClient | null = null;

  // Credit status tracking — reactive, no polling
  private _creditsExhausted = false;
  private _creditsExhaustedSince: string | null = null;

  get creditsExhausted(): boolean { return this._creditsExhausted; }
  get creditsExhaustedSince(): string | null { return this._creditsExhaustedSince; }

  /** Called when any API call fails with a credit/billing error */
  markCreditsExhausted(): void {
    if (!this._creditsExhausted) {
      this._creditsExhausted = true;
      this._creditsExhaustedSince = new Date().toISOString();
      this.logger.warn('Credit status changed: EXHAUSTED');
      this.emit('credits-exhausted', { since: this._creditsExhaustedSince });
    }
  }

  /** Called when any API call succeeds — credits are back */
  markCreditsAvailable(): void {
    if (this._creditsExhausted) {
      this._creditsExhausted = false;
      this._creditsExhaustedSince = null;
      this.logger.info('Credit status changed: AVAILABLE');
      this.emit('credits-available');
    }
  }

  // Model configuration - populated from config or defaults
  // Uses explicit mutable type rather than `typeof DEFAULT_MODELS` which is readonly due to `as const`
  private models: {
    generation: string;
    quickCheck: string;
    patch: string;
    fullPatch: string;
  };

  constructor() {
    super();
    this.logger = createLogger('AnthropicService');
    this.models = { ...DEFAULT_MODELS };
  }

  async initialize(): Promise<void> {
    const config = ConfigService.getInstance().getConfig();
    // Load model overrides from config
    const configModels = config.anthropic?.models;
    if (configModels) {
      if (configModels.generation) this.models.generation = configModels.generation;
      if (configModels.quickCheck) this.models.quickCheck = configModels.quickCheck;
      if (configModels.patch) this.models.patch = configModels.patch;
      if (configModels.fullPatch) this.models.fullPatch = configModels.fullPatch;
    }
    // Also support legacy config.anthropic.model for generation
    if (config.anthropic?.model) {
      this.models.generation = config.anthropic.model;
    }

    this.client = this.getClient();
    const factoryState = backgroundUsesPlan('insights') ? { mode: 'chatgpt-plan' } : anthropicClientFactory.getState();
    if (!this.client) {
      this.logger.warn('Anthropic service initialized without active client', {
        mode: factoryState.mode,
      });
      return;
    }

    this.logger.info('Anthropic service initialized', {
      models: this.models,
      mode: factoryState.mode,
    });
  }

  /** Insight calls (missions, session names, patches) unless the caller names its own job. */
  private getClient(job: BackgroundJob = 'insights'): BackgroundTextClient | null {
    const client = backgroundTextClient.getClient(job);
    if (job === 'insights') this.client = client;
    return client;
  }

  /**
   * Execute a function with exponential backoff retry on transient errors.
   */
  private async withRetry<T>(
    operation: string,
    fn: () => Promise<T>,
    config: RetryConfig = DEFAULT_RETRY_CONFIG
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      try {
        const result = await fn();
        // API call succeeded — if credits were previously exhausted, they're back
        this.markCreditsAvailable();
        return result;
      } catch (error) {
        lastError = error;

        // Don't retry non-retryable errors
        if (!isRetryableError(error)) {
          throw error;
        }

        // Don't retry after max attempts
        if (attempt >= config.maxRetries) {
          this.logger.warn(`${operation}: All ${config.maxRetries} retries exhausted`, {
            error: error instanceof Error ? error.message : String(error)
          });
          throw error;
        }

        const delayMs = calculateBackoff(attempt, config);
        this.logger.info(`${operation}: Retry ${attempt + 1}/${config.maxRetries} after ${Math.round(delayMs)}ms`, {
          error: error instanceof Error ? error.message : String(error)
        });
        await sleep(delayMs);
      }
    }

    throw lastError;
  }

  async checkHealth(): Promise<AnthropicHealthResponse> {
    const client = this.getClient();
    if (!client) {
      return {
        status: 'unhealthy',
        message: 'Anthropic client not configured',
        apiKeyValid: false
      };
    }

    try {
      const response = await this.withRetry('checkHealth', () =>
        client.messages.create({
          model: this.models.generation,
          max_tokens: 50,
          thinking: THINKING,
          messages: [{ role: 'user', content: 'Say "ok" and nothing else.' }]
        })
      );

      const text = response.content[0]?.type === 'text' ? response.content[0].text : null;
      if (text) {
        return {
          status: 'healthy',
          message: 'Anthropic API is accessible',
          apiKeyValid: true
        };
      }

      return {
        status: 'unhealthy',
        message: 'Unexpected response from Anthropic API',
        apiKeyValid: true
      };
    } catch (error) {
      this.logger.error('Health check failed', { error });
      return {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Unknown error',
        apiKeyValid: false
      };
    }
  }

  /**
   * Log cost for an LLM API call.
   * Call this after each API call to track costs.
   */
  private logCost(
    response: Anthropic.Message,
    operation: LLMOperationType,
    model: string,
    durationMs: number,
    sessionId?: string
  ): void {
    try {
      const costTracker = getCostTracker();
      costTracker.log({
        sessionId: sessionId || 'unknown',
        operation,
        ...backgroundProvenance(response, model),
        inputTokens: response.usage?.input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0,
        cacheCreationInputTokens: response.usage?.cache_creation_input_tokens || 0,
        cacheReadInputTokens: response.usage?.cache_read_input_tokens || 0,
        durationMs,
      });
    } catch (error) {
      // Don't let cost logging failures break the main flow
      this.logger.debug('Failed to log cost', { error, operation });
    }
  }

  /**
   * A mission that is too long to show whole, or names something the input
   * does not contain, goes back to the model once with the problem stated.
   * Returns the mission to show, or null to keep whatever was shown before:
   * a detail still missing from the input after the second try means the
   * model cannot name this session correctly. A second answer that is still
   * too long is kept whole; nothing here cuts it.
   */
  private async fitMission(
    client: BackgroundTextClient,
    system: string,
    userContent: string,
    firstReply: string,
    mission: string,
    sessionId?: string,
  ): Promise<string | null> {
    const problems = (candidate: string) => {
      const found: string[] = [];
      if (candidate.length > MISSION_MAX_CHARS) found.push(`it is ${candidate.length} characters and has to fit in ${MISSION_MAX_CHARS}`);
      const unsupported = unsupportedDetails(candidate, userContent);
      if (unsupported.length > 0) found.push(`it names ${unsupported.map((d) => `"${d}"`).join(', ')}, which the input does not contain`);
      return { found, unsupported };
    };

    const first = problems(mission);
    if (first.found.length === 0) return mission;
    this.logger.info('Mission sent back to the model', { sessionId, mission, problems: first.found });

    const startTime = Date.now();
    const response = await this.withRetry('fitMission', () =>
      client.messages.create({
        model: this.models.generation,
        max_tokens: 100,
        thinking: THINKING,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [
          { role: 'user', content: userContent },
          { role: 'assistant', content: firstReply },
          {
            role: 'user',
            content: `The mission "${mission}" does not work: ${first.found.join('; ')}. ` +
              `Write it again so it fits in ${MISSION_MAX_CHARS} characters and names only things written in the input. ` +
              'Reply with only JSON: {"mission": "..."}, or {"mission": null} if you cannot.',
          },
        ],
      })
    );
    this.logCost(response, 'MISSION_FIT', this.models.generation, Date.now() - startTime, sessionId);

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const braces = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    let second: unknown = null;
    try {
      second = (parseJson(braces) as { mission?: unknown }).mission;
    } catch {
      second = null;
    }
    if (typeof second !== 'string' || !second.trim()) {
      this.logger.info('Mission withdrawn after a fit request', { sessionId, mission, problems: first.found });
      return null;
    }

    const retry = normalizeMissionText(second);
    const after = problems(retry);
    if (after.unsupported.length > 0) {
      this.logger.info('Mission dropped: names details the input does not contain', { sessionId, mission: retry, details: after.unsupported });
      return null;
    }
    return retry;
  }

  /**
   * Extract rich, structured session insights using Sonnet.
   * Returns: context (project, area, mission, scope), theme, and tags (complexity).
   */
  async extractSessionInsights(conversationText: string, sessionId?: string): Promise<ExtractedInsights> {
    const client = this.getClient();
    if (!client) {
      throw new LatticeError('ANTHROPIC_API_KEY_MISSING', 'Anthropic API key not configured', 400);
    }

    const systemPrompt = `You are analyzing a coding session transcript to extract structured information for a dashboard display.

The goal: Someone glancing at this dashboard should immediately understand what this session is about.

What you are shown: the messages the user typed and, for a session a coordinator started, the brief it was started with. Messages from other agents, workers and the server were left out, so a short reply like "yeah do it" may be answering something you cannot see. Do not guess at what it answered. If neither the brief nor the user's messages show what the session is for, set context.mission to null instead of inferring one from the assistant responses or task list; a missing mission is better than a wrong one.

Names and details: every name, number, version, ticket id, repo, product or person in the mission must appear exactly as written in the input ("Opus 5.5", not "Opus 5"; the ticket the user named, not a neighbouring one). If you are not sure of a detail, use a plain word instead ("the model upgrade", "an image bug"). A vague title is fine; a wrong detail is not.

Extract the following:

1. CONTEXT - Identity of the session:
   - project: The actual project/tool/codebase being worked ON in this session. Derive this from the conversation content — what is the user building, fixing, or discussing? The working directory may be provided as a hint, but ONLY use it if it clearly identifies a specific project (e.g. "/home/alex/code/recipe-planner" → "Recipe Planner"). IGNORE generic paths like home directories (e.g. "/home/user", "/Users/alex", "~"). IMPORTANT: The orchestrator/dashboard tool that manages these sessions lives at a directory called "lattice" — if the session is working on the orchestrator/dashboard itself, use "Lattice".
   - area: The specific component/module/domain if applicable (null if general)
   - mission: The session's overall purpose as a concise phrase, or null when the input does not show it. It is shown whole as a one-line title and never cut, so write it to fit: at most ${MISSION_MAX_CHARS} characters. This is the through-line of the WHOLE session — what someone would say the session is for — NOT the sub-task currently in progress. Sessions wander through tangents and mini-tasks; weigh the earliest requests and recurring goals over the most recent messages. Be specific and concrete. Avoid filler intros like "The goal is to..."
   - scope: "minor" (quick fix), "feature" (meaningful addition), "major" (significant change)

2. CATEGORIES - Work-type classification from this CLOSED set (use these exact words):
${SESSION_CATEGORIES.map((c) => `   - ${c}: ${SESSION_CATEGORY_DEFINITIONS[c]}`).join('\n')}
   - primary: The dominant thread of the WHOLE session, arc-weighted like the mission — not whatever happened most recently. Sessions often end in shipping or polish; that tail does not define them.
   - secondary: 0-2 OTHER categories that were substantial threads of their own (not incidental moments). Most real sessions have 1-2.

3. THEME - One or two words (prefer a gerund) capturing this specific session's spirit. Be evocative, even playful — this is flavor, not classification. Examples: "bug-swatting", "rabbit-holing", "unbricking", "soul-searching", "backlog gardening". Do NOT just repeat a category name.

4. TAGS - Quick categorization for filtering/display:
   - complexity: Session difficulty - "routine" (straightforward), "tricky" (requires care), "gnarly" (complex/hairy - reserved for multi-system debugging or architecture-spanning changes)

CRITICAL OUTPUT INSTRUCTIONS:
- Respond with ONLY valid JSON
- Do NOT include explanatory text before or after the JSON
- Do NOT include markdown code blocks or formatting
- Start your response with { and end with }
- No prose, no commentary, ONLY the JSON object
- Ensure context.mission is at most ${MISSION_MAX_CHARS} characters

JSON Structure:
{
  "context": { "project": "string", "area": "string|null", "mission": "string|null", "scope": "minor|feature|major" },
  "categories": { "primary": "string", "secondary": ["string"] },
  "theme": "string",
  "tags": { "complexity": "routine|tricky|gnarly" }
}`;

    const userContent = `Analyze this coding session and extract structured insights:\n\n${conversationText}`;
    let responseText: string | null = null;
    const startTime = Date.now();
    try {
      const response = await this.withRetry('extractSessionInsights', () =>
        client.messages.create({
          model: this.models.generation,
          max_tokens: 500,  // Reduced - only extracting context, theme, tags now
          thinking: THINKING,
          // Reuse the instructions across sessions and fit requests. The input
          // and output stay fresh; only this identical prefix is cached.
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          // No assistant prefill: the 5-family rejects a trailing assistant
          // turn with a 400. The system prompt's ONLY-JSON instructions plus
          // the brace-extraction fallbacks below carry the same guarantee.
          messages: [{ role: 'user', content: userContent }]
        })
      );
      const durationMs = Date.now() - startTime;

      // Log cost for GENERATE operation
      this.logCost(response, 'GENERATE', this.models.generation, durationMs, sessionId);

      responseText = response.content[0]?.type === 'text' ? response.content[0].text : null;
      if (!responseText) {
        throw new LatticeError('ANTHROPIC_INSIGHTS_ERROR', 'No response text returned', 500);
      }

      // Extract JSON from response with multiple fallback strategies
      let jsonText = responseText.trim();

      // Strategy 1: Try to extract from markdown code blocks
      const codeBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonText = codeBlockMatch[1].trim();
      } else {
        // Strategy 2: Look for content between first { and last }
        const firstBrace = jsonText.indexOf('{');
        const lastBrace = jsonText.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          jsonText = jsonText.substring(firstBrace, lastBrace + 1);
        }
      }

      // Log the extracted JSON for debugging
      this.logger.debug('Extracted JSON from LLM response', {
        responsePreview: responseText.slice(0, 100),
        extractedPreview: jsonText.slice(0, 100),
        usedCodeBlock: !!codeBlockMatch
      });

      const parsed = parseJson(jsonText) as {
        context?: Omit<SessionContext, 'mission'> & { mission?: string | null };
        categories?: { primary?: string; secondary?: string[] };
        theme?: string;
        tags?: SessionTags;
      };

      // Validate structure - context is required
      if (!parsed.context) {
        throw new LatticeError('ANTHROPIC_INSIGHTS_ERROR', 'Invalid response structure: missing context', 500);
      }

      // An explicit null is the model declining: the user's messages do not
      // say what the session is for. Callers keep what they had.
      const mission = parsed.context.mission;
      if (mission === null || (typeof mission === 'string' && !mission.trim())) {
        this.logger.info('Session insights declined: user messages do not show the mission', { sessionId });
        return { context: null, theme: '', categories: null, tags: null };
      }
      if (typeof mission !== 'string') {
        throw new LatticeError('ANTHROPIC_INSIGHTS_ERROR', 'Invalid response structure: missing mission', 500);
      }

      // Validate categories against the closed enum; a hallucinated value
      // degrades to null rather than poisoning the icon layer.
      const rawCategories = parsed.categories;
      const categories: SessionCategorySet | null = isSessionCategory(rawCategories?.primary)
        ? {
            primary: rawCategories.primary,
            secondary: (rawCategories?.secondary ?? [])
              .filter(isSessionCategory)
              .filter((c) => c !== rawCategories.primary)
              .slice(0, 2),
          }
        : null;

      const fitted = await this.fitMission(client, systemPrompt, userContent, responseText, normalizeMissionText(mission), sessionId);
      if (fitted === null) {
        return { context: null, theme: '', categories: null, tags: null };
      }

      const result: ExtractedInsights = {
        context: {
          ...parsed.context,
          mission: fitted,
        },
        theme: parsed.theme || 'working',
        categories,
        tags: parsed.tags || null,
      };

      this.logger.info('Session insights extracted', {
        model: this.models.generation,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
        project: parsed.context.project,
        theme: result.theme
      });

      return result;
    } catch (error) {
      if (error instanceof LatticeError) {
        throw error;
      }

      // Check for credit/billing errors and make them LOUD
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('credit balance') || errorMessage.includes('billing')) {
        this.markCreditsExhausted();
        this.logger.error('🚨 ANTHROPIC API CREDITS EXHAUSTED 🚨', {
          errorMessage,
          action: 'ADD CREDITS AT https://console.anthropic.com/settings/billing'
        });
        throw new LatticeError('ANTHROPIC_NO_CREDITS', '🚨 Anthropic API credits exhausted. Add credits at https://console.anthropic.com/settings/billing', 402);
      }

      // Log error with proper serialization AND the response that failed to parse
      this.logger.error('Session insights extraction failed', {
        errorMessage,
        errorStack: error instanceof Error ? error.stack : undefined,
        errorType: error?.constructor?.name,
        // Include the actual response for debugging
        responsePreview: responseText?.slice(0, 500) || 'no response'
      });
      throw new LatticeError('ANTHROPIC_INSIGHTS_ERROR', 'Failed to extract session insights', 500);
    }
  }

  isConfigured(): boolean {
    return this.getClient() !== null;
  }

  /**
   * Quick check to determine if insights need patching.
   *
   * This is a fast, cheap call that just answers "has anything meaningful changed?"
   * based on recent actions. If yes, we'll follow up with Sonnet for actual patching.
   */
  async quickCheckInsightsStale(
    currentInsights: {
      mission: string;
      purpose?: string;
    },
    recentActions: string[],
    sessionId?: string
  ): Promise<{ needsPatch: boolean; reason: string }> {
    const client = this.getClient();
    if (!client) {
      return { needsPatch: false, reason: 'Anthropic not configured' };
    }

    const startTime = Date.now();

    try {
      const actionsStr = recentActions.join('\n');
      const purposeStr = currentInsights.purpose || currentInsights.mission;

      const prompt = `Current session state:
- Mission: "${currentInsights.mission}"
- Current purpose: "${purposeStr}"

Recent activity:
${actionsStr}

Should the session purpose be updated to reflect the recent activity?

Say YES (needsPatch: true) if:
- Focus shifted to a new area or topic
- Something significant happened worth capturing
- The purpose feels stale compared to what just happened

Say NO if the recent actions are trivial or already reflected in the current purpose.

Respond with JSON only:
{"needsPatch": true/false, "reason": "brief explanation"}`;

      const response = await this.withRetry('quickCheckInsightsStale', () =>
        client.messages.create({
          model: this.models.quickCheck,
          max_tokens: 100,
          thinking: THINKING,
          messages: [{ role: 'user', content: prompt }]
        })
      );

      const duration = Date.now() - startTime;
      const text = response.content[0]?.type === 'text' ? response.content[0].text : '';

      // Log cost for QUICK_CHECK operation
      this.logCost(response, 'QUICK_CHECK', this.models.quickCheck, duration, sessionId);

      // Log for observability
      this.logger.info('Quick check completed', {
        durationMs: duration,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
        recentActionsCount: recentActions.length,
        responsePreview: text.slice(0, 100)
      });

      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        const result = parseJson(jsonMatch?.[0] || text) as QuickCheckResponse;

        return {
          needsPatch: result.needsPatch === true,
          reason: result.reason || 'No reason provided'
        };
      } catch {
        this.logger.debug('Failed to parse quick check response', { text });
        return { needsPatch: false, reason: 'Parse error - keeping cached' };
      }
    } catch (error) {
      // Check for credit/billing errors and make them LOUD
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('credit balance') || errorMessage.includes('billing')) {
        this.markCreditsExhausted();
        this.logger.error('🚨 ANTHROPIC API CREDITS EXHAUSTED 🚨', {
          errorMessage,
          action: 'ADD CREDITS AT https://console.anthropic.com/settings/billing',
          context: 'Quick check failed due to billing issue'
        });
      } else {
        this.logger.error('Quick check failed', { error });
      }
      return { needsPatch: false, reason: 'Check error - keeping cached' };
    }
  }

  /**
   * Generate fast patch for session purpose only.
   *
   * Theme/tags are now evaluated on user message (evaluateSessionMetadata),
   * so this method only updates the evolving session purpose based on
   * what Claude actually did (vs what user asked for).
   */
  async generateFastPatch(
    currentInsights: {
      mission?: string;
      purpose?: string;
    },
    recentActivity: Array<{ type: string; content: string }>,
    sessionId?: string
  ): Promise<{
    purpose?: string;
  } | null> {
    const client = this.getClient();
    if (!client || recentActivity.length === 0) {
      return null;
    }

    const missionStr = currentInsights.mission || '(not set)';
    const purposeStr = currentInsights.purpose || missionStr;
    const activityStr = recentActivity.slice(-10).map(a => `[${a.type}] ${a.content}`).join('\n');

    // Simplified prompt - only evaluate purpose, not theme/tags
    // Theme/tags are now evaluated on user message to prevent flip-flopping
    const prompt = `You are updating a coding session dashboard based on recent activity.

ORIGINAL SESSION MISSION (frozen at start):
${missionStr}

CURRENT PURPOSE (what session has evolved to):
${purposeStr}

RECENT ACTIVITY:
${activityStr}

Based on what was just accomplished, update the session purpose:

**purpose** (30-50 chars): What is this session about NOW?
- The session's current identity/focus
- Keep concise: "Building auth system" not "We are currently..."
- May match the original mission, or may have evolved

Respond with ONLY valid JSON:
{"purpose": "current session focus"}`;

    let rawResponse = '';
    const startTime = Date.now();
    try {
      const response = await this.withRetry('generateFastPatch', () =>
        client.messages.create({
          model: this.models.patch,
          max_tokens: 100,  // Reduced - only extracting purpose now
          thinking: THINKING,
          messages: [{
            role: 'user',
            content: prompt
          }]
        })
      );
      const durationMs = Date.now() - startTime;

      // Log cost for FAST_PATCH operation
      this.logCost(response, 'FAST_PATCH', this.models.patch, durationMs, sessionId);

      const textContent = response.content.find(block => block.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        return null;
      }

      rawResponse = textContent.text;
      let jsonText = textContent.text.trim();

      // Strip markdown code blocks if present
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      }

      // Extract JSON object
      const jsonMatch = jsonText.match(/\{[\s\S]*\}(?=\s*$)/);
      if (jsonMatch) {
        jsonText = jsonMatch[0];
      } else if (!jsonText.startsWith('{')) {
        this.logger.debug('FastPatch response is not JSON', { preview: jsonText.slice(0, 200) });
        return null;
      }

      const result = parseJson(jsonText) as FastPatchResponse;

      // Validate structure - purpose is required
      if (!result.purpose || typeof result.purpose !== 'string') {
        this.logger.debug('FastPatch missing purpose', { keys: Object.keys(result) });
        return null;
      }

      return {
        purpose: result.purpose,
      };
    } catch (error) {
      this.logger.debug('FastPatch generation failed', {
        error: error instanceof Error ? error.message : String(error),
        responsePreview: rawResponse.slice(0, 200),
      });
      return null;
    }
  }

  /**
   * Generate targeted patches to insights using Sonnet.
   *
   * Called when quickCheckInsightsStale returns needsPatch=true.
   * Returns specific patches to apply rather than regenerating everything.
   *
   * @param useFastPath - If true, only generate currentState through the short patch path
   */
  async generateInsightsPatch(
    currentInsights: {
      mission: string;
      theme: string;
      purpose?: string;
    },
    recentActivity: Array<{ type: string; content: string; timestamp?: string }>,
    useFastPath: boolean = true,  // Default to fast path for better UX
    sessionId?: string
  ): Promise<{
    patches: {
      purpose?: string;
    };
    reason: string;
  }> {
    const client = this.getClient();
    if (!client) {
      return { patches: {}, reason: 'Anthropic not configured' };
    }

    const startTime = Date.now();

    try {
      // Fast path: generate purpose without recomputing the other fields.
      if (useFastPath) {
        this.logger.debug('Using fast path for patch generation');
        const fastPatch = await this.generateFastPatch(
          {
            mission: currentInsights.mission,
            purpose: currentInsights.purpose,
          },
          recentActivity,
          sessionId
        );

        const totalTime = Date.now() - startTime;

        if (fastPatch && fastPatch.purpose) {
          this.logger.info('Fast path patch completed', {
            durationMs: totalTime,
            purpose: fastPatch.purpose,
          });

          return {
            patches: { purpose: fastPatch.purpose },
            reason: `Fast path: Updated purpose from recent activity`,
          };
        }
        // Fall through to full path if fast path fails
        this.logger.debug('Fast path returned null, falling back to full patch generation');
      }

      const activityStr = recentActivity.slice(-10).map(a => `[${a.type}] ${a.content}`).join('\n');

      const prompt = `You are analyzing a coding session transcript to update a dashboard display.

CURRENT SESSION:
Mission: "${currentInsights.mission}"
Theme: ${currentInsights.theme}
Purpose: ${currentInsights.purpose || currentInsights.mission}

RECENT ACTIVITY:
${activityStr}

Based on what happened, extract the session's current **purpose** (what it's about NOW).

**purpose**: 30-50 chars describing the session's current focus
- What someone would say if asked "what are you working on?"
- Keep it concise: "Building auth system" not "We are currently..."
- May match the original mission, or may have pivoted

Response format (JSON only):
{
  "reason": "brief explanation",
  "patches": {
    "purpose": "current session focus"
  }
}`;

      const response = await this.withRetry('generateInsightsPatch', () =>
        client.messages.create({
          model: this.models.fullPatch,
          max_tokens: 150,  // Only extracting purpose now
          thinking: THINKING,
          messages: [{ role: 'user', content: prompt }]
        })
      );

      const duration = Date.now() - startTime;
      const text = response.content[0]?.type === 'text' ? response.content[0].text : '';

      // Log cost for PATCH operation (full path)
      this.logCost(response, 'PATCH', this.models.fullPatch, duration, sessionId);

      this.logger.info('Fallback patch generation (Sonnet) completed', {
        durationMs: duration,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
      });

      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        const jsonToParse = jsonMatch?.[0] || text;
        const result = parseJson(jsonToParse) as PatchResponse;
        const patches = result.patches || {};

        return {
          patches,
          reason: result.reason || 'Fallback patch generated',
        };
      } catch (parseError) {
        this.logger.warn('Failed to parse fallback patch response', {
          error: parseError instanceof Error ? parseError.message : String(parseError),
          textPreview: text.slice(0, 200),
        });
        return { patches: {}, reason: 'Parse error - no patches applied' };
      }
    } catch (error) {
      // Check for credit/billing errors and make them LOUD
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('credit balance') || errorMessage.includes('billing')) {
        this.markCreditsExhausted();
        this.logger.error('🚨 ANTHROPIC API CREDITS EXHAUSTED 🚨', {
          errorMessage,
          action: 'ADD CREDITS AT https://console.anthropic.com/settings/billing',
          context: 'Patch generation failed due to billing issue'
        });
      } else {
        this.logger.error('Patch generation failed', { error });
      }
      return { patches: {}, reason: 'Generation error - no patches applied' };
    }
  }

  /**
   * Summarize what the user is currently asking Claude to do.
   *
   * Called immediately when a user message is detected, this generates a brief
   * description that makes sense even if the user just said "do it" - because
   * we provide recent conversation context.
   *
   * The goal is "what would you tell someone
   * who walked in and asked what you're working on right now?"
   */
  async summarizeCurrentWork(
    userMessage: string,
    recentContext: Array<{ type: 'user' | 'assistant'; content: string }>,
    sessionMission?: string,
    sessionId?: string
  ): Promise<{ summary: string } | null> {
    const client = this.getClient();
    if (!client) {
      return null;
    }

    const startTime = Date.now();

    try {
      // Build context from recent conversation (last few exchanges)
      const contextStr = recentContext.length > 0
        ? recentContext.map(m => `[${m.type === 'user' ? 'User' : 'Claude'}]: ${m.content.slice(0, 500)}`).join('\n\n')
        : '(new conversation)';

      const missionStr = sessionMission ? `Session mission: ${sessionMission}\n\n` : '';

      const prompt = `${missionStr}Recent conversation context:
${contextStr}

The user just sent this message:
"${userMessage}"

In 5-10 words, what is the user asking Claude to do RIGHT NOW?
- Be specific and concrete (not "continuing work" or "helping with code")
- If the user said something vague like "do it" or "yes" or "go ahead", infer from context what "it" refers to
- Use action verbs: "Implementing...", "Fixing...", "Adding...", "Debugging..."
- If truly unclear, describe what can be inferred

Respond with ONLY the summary text, nothing else. No quotes, no explanation.`;

      const response = await this.withRetry('summarizeCurrentWork', () =>
        client.messages.create({
          model: this.models.quickCheck,
          max_tokens: 50,
          thinking: THINKING,
          messages: [{ role: 'user', content: prompt }]
        })
      );

      const durationMs = Date.now() - startTime;

      // Log cost
      this.logCost(response, 'CURRENT_WORK', this.models.quickCheck, durationMs, sessionId);

      // Strip trailing period - we want consistency with history items which never end with periods
      const rawText = response.content[0]?.type === 'text' ? response.content[0].text.trim() : null;
      const text = rawText?.replace(/\.+$/, '') || null;

      if (!text) {
        return null;
      }

      this.logger.info('Current work summarized', {
        durationMs,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
        summary: text.slice(0, 50),
      });

      return { summary: text };
    } catch (error) {
      this.logger.debug('Failed to summarize current work', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * A project name too long for its line, or naming something the outcome does
   * not, goes back to the model once with the problem stated, as missions do in
   * `fitMission`. Returns null when the second answer still names something
   * the outcome does not; a second answer that is still long is kept whole.
   */
  private async fitProjectName(
    client: BackgroundTextClient,
    prompt: string,
    firstReply: string,
    name: string,
    outcome: string,
    sessionId?: string,
  ): Promise<string | null> {
    const problems: string[] = [];
    if (name.length > PROJECT_NAME_MAX_CHARS) problems.push(`it is ${name.length} characters and has to fit in ${PROJECT_NAME_MAX_CHARS}`);
    const unsupported = unsupportedDetails(name, outcome);
    if (unsupported.length > 0) problems.push(`it names ${unsupported.map((d) => `"${d}"`).join(', ')}, which the outcome does not contain`);
    if (problems.length === 0) return name;
    this.logger.info('Project name sent back to the model', { sessionId, name, problems });

    const startTime = Date.now();
    const response = await this.withRetry('fitProjectName', () =>
      client.messages.create({
        model: this.models.quickCheck,
        max_tokens: 30,
        thinking: THINKING,
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: firstReply },
          {
            role: 'user',
            content: `The name "${name}" does not work: ${problems.join('; ')}. ` +
              `Write it again so it fits in ${PROJECT_NAME_MAX_CHARS} characters and names only things written in the outcome. ` +
              'Respond with ONLY the name, nothing else.',
          },
        ],
      })
    );
    this.logCost(response, 'PROJECT_NAME', this.models.quickCheck, Date.now() - startTime, sessionId);

    const raw = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const retry = normalizeProjectName(raw);
    if (!retry) {
      this.logger.info('Project name withdrawn after a fit request', { sessionId, name, raw });
      return null;
    }
    const stillUnsupported = unsupportedDetails(retry, outcome);
    if (stillUnsupported.length > 0) {
      this.logger.info('Project name dropped: names details the outcome does not contain', { sessionId, name: retry, details: stillUnsupported });
      return null;
    }
    return retry;
  }

  /**
   * The short title a project carries in the sidebar, written from the outcome
   * its coordinator has agreed with the user.
   *
   * The outcome is the whole input on purpose. A project's insight mission is
   * re-read from the transcript every turn, so it drifts onto whatever task is
   * in flight — one project here was called "Orient on Lattice restyle project
   * state" at 19:01 and "Simplify app UI and clean up sidebar/header" fourteen
   * minutes later, while the thing being owned never changed. The outcome moves
   * only when someone decides it does, which is the property a name needs.
   *
   * Returns null rather than a fallback string: an absent name falls through to
   * the mission, and a project labelled with a failed generation would be worse
   * than one labelled with a drifting mission.
   */
  async generateProjectName(outcome: string, sessionId?: string): Promise<string | null> {
    const client = this.getClient('projectName');
    if (!client) return null;

    const startTime = Date.now();

    try {
      const prompt = `A "project" is a long-running piece of work someone owns. This is the outcome its owner has agreed it is working towards:

"${outcome}"

Write the project's name, as it will appear in a sidebar list next to their other projects.

- Name the thing being owned, not the work being done to it. "Lattice workspace improvements", not "Simplify the sidebar".
- A noun phrase. No leading verb, no "Improve/Build/Fix/Turn ... into".
- Use the full ${PROJECT_NAME_MAX_CHARS} characters if the name needs them. A name is only too long if it passes ${PROJECT_NAME_MAX_CHARS}; it is shown whole and never cut, so a longer one does not fit. It is too short the moment it drops a word that distinguishes this project from a neighbouring one.
- Every name, product and version in it must appear in the outcome exactly as written there.
- Keep the outcome's concrete nouns — product, system and domain names are what make a project recognisable in a list. Drop the verbs and the qualifiers.
- Never end on a bare generic noun ("and app", "and work", "system stuff"). If a word is worth keeping, keep the word that identifies it.
- It has to stay right for months, while the tasks underneath it change. Nothing about the current step belongs in it.
- Sentence case. No quotes, no trailing period.

Respond with ONLY the name, nothing else.`;

      const response = await this.withRetry('generateProjectName', () =>
        client.messages.create({
          model: this.models.quickCheck,
          max_tokens: 30,
          thinking: THINKING,
          messages: [{ role: 'user', content: prompt }]
        })
      );

      const durationMs = Date.now() - startTime;
      this.logCost(response, 'PROJECT_NAME', this.models.quickCheck, durationMs, sessionId);

      const raw = response.content[0]?.type === 'text' ? response.content[0].text : '';
      const first = normalizeProjectName(raw);
      if (!first) {
        this.logger.debug('Project name generation produced nothing usable', { raw });
        return null;
      }
      const name = await this.fitProjectName(client, prompt, raw, first, outcome, sessionId);
      if (!name) return null;

      this.logger.info('Project name generated', {
        durationMs,
        outcome,
        name,
      });
      return name;
    } catch (error) {
      this.logger.debug('Failed to generate project name', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Evaluate session metadata (purpose/theme/tags) based on user message and context.
   * Called on user message to update session classification. This replaces the
   * timer-based fast patch approach with explicit user-message triggering.
   */
  async evaluateSessionMetadata(
    userMessage: string,
    recentContext: Array<{ type: 'user' | 'assistant'; content: string }>,
    current: {
      mission?: string;
      purpose?: string;
      theme?: string;
      tags?: { complexity?: string };
    },
    sessionId?: string
  ): Promise<{
    purpose?: string;
    theme?: string;
    tags?: { complexity?: string };
  } | null> {
    const client = this.getClient();
    if (!client) {
      return null;
    }

    const startTime = Date.now();

    try {
      // Build context from recent conversation
      const contextStr = recentContext.length > 0
        ? recentContext.map(m => `[${m.type === 'user' ? 'User' : 'Claude'}]: ${m.content.slice(0, 400)}`).join('\n\n')
        : '(new conversation)';

      const missionStr = current.mission || '(not set)';
      const purposeStr = current.purpose || missionStr;
      const currentTheme = current.theme || 'exploring';
      const currentComplexity = current.tags?.complexity || 'routine';

      const prompt = `You classify coding session activity based on what the user just asked for.

SESSION MISSION: ${missionStr}
CURRENT PURPOSE: ${purposeStr}
CURRENT THEME: ${currentTheme}
CURRENT COMPLEXITY: ${currentComplexity}

Recent conversation:
${contextStr}

User just sent: "${userMessage.slice(0, 500)}"

Based on what the user is now asking Claude to do, update:

1. **purpose** (30-50 chars): Session's current focus. Keep concise.
2. **theme** (single word): "debugging" | "building" | "exploring" | "firefighting" | "refactoring" | "designing" | "investigating" | "polishing"
3. **complexity**: "routine" | "tricky" | "gnarly"
   - routine: straightforward task
   - tricky: requires care, has edge cases
   - gnarly: complex/hairy - multi-system debugging or architecture-spanning changes

IMPORTANT: Only change values if this message clearly shifts the session's focus. Preserve current values for continuation messages like "yes", "do it", "continue".

Respond with ONLY valid JSON:
{"purpose": "...", "theme": "...", "tags": {"complexity": "..."}}`;

      const response = await this.withRetry('evaluateSessionMetadata', () =>
        client.messages.create({
          model: this.models.quickCheck,
          max_tokens: 150,
          thinking: THINKING,
          messages: [{ role: 'user', content: prompt }]
        })
      );

      const durationMs = Date.now() - startTime;

      // Log cost
      this.logCost(response, 'METADATA_EVAL', this.models.quickCheck, durationMs, sessionId);

      const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : null;

      if (!text) {
        return null;
      }

      // Parse JSON response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.debug('No JSON found in metadata eval response', { text });
        return null;
      }

      const parsed = parseJson(jsonMatch[0]) as MetadataEvalResponse;

      this.logger.info('Session metadata evaluated', {
        durationMs,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
        theme: parsed.theme,
        purpose: parsed.purpose?.slice(0, 30),
      });

      return {
        purpose: parsed.purpose,
        theme: parsed.theme,
        tags: parsed.tags,
      };
    } catch (error) {
      this.logger.debug('Failed to evaluate session metadata', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Generate permission pattern suggestions.
   *
   * Called immediately when a permission request arrives, this generates
   * contextually-aware pattern options. By the time the user clicks
   * "Similar", suggestions should already be ready.
   *
   * @param toolName - The tool being invoked (e.g., "Bash", "Write")
   * @param toolInput - The tool input parameters (e.g., { command: "..." })
   * @returns Array of suggested patterns from most specific to broadest
   */
  async suggestPermissionPatterns(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<string[]> {
    const client = this.getClient('permissionPatterns');
    if (!client) {
      return [];
    }

    const startTime = Date.now();

    try {
      // Build context based on tool type
      let contextStr: string;
      let valueStr: string;

      if (toolName === 'Bash') {
        const command = (toolInput.command as string) || '';
        valueStr = command;
        contextStr = `Bash command: ${command}`;
      } else if (['Write', 'Read', 'Edit'].includes(toolName)) {
        const filePath = (toolInput.file_path as string) || '';
        valueStr = filePath;
        contextStr = `${toolName} file: ${filePath}`;
      } else {
        // Unknown tool - return basic suggestions
        return [
          `${toolName}(${JSON.stringify(toolInput).slice(0, 50)})`,
          toolName
        ];
      }

      const prompt = `You help users create permission patterns for a coding assistant tool.

The user is being asked to approve: ${contextStr}

Generate permission patterns from MOST SPECIFIC (safest) to LEAST SPECIFIC (broadest).
Each pattern should be meaningfully different and useful.

For Bash commands:
- Understand the INTENT behind the command, not just the literal text
- Extract the core tool and action (e.g., "git commit" from "git commit -m 'msg'")
- For piped commands like "fd -e tsx | head", focus on the primary command (fd)
- For chained commands like "npm install && npm run build", focus on the first command (npm install)

Pattern syntax:
- Bash(exact command) - matches only this exact command
- Bash(git commit *) - matches any git commit command
- Bash(git *) - matches any git command
- Bash - matches all bash commands

For file operations:
- Write(/exact/path/file.tsx) - exact file only
- Write(/path/to/dir/*.tsx) - any .tsx in that directory
- Write(/path/**/*.tsx) - any .tsx recursively under path
- Write(*.tsx) - any .tsx file anywhere
- Write - all write operations

Generate 3-5 patterns, ordered from safest to broadest.
IMPORTANT: Only return patterns that make semantic sense for this operation.

Respond with ONLY a JSON array of pattern strings:
["pattern1", "pattern2", ...]`;

      const response = await this.withRetry('suggestPermissionPatterns', () =>
        client.messages.create({
          model: this.models.quickCheck,
          max_tokens: 200,
          thinking: THINKING,
          messages: [{ role: 'user', content: prompt }]
        })
      );

      const durationMs = Date.now() - startTime;

      // Log cost for PERMISSION_PATTERNS operation
      this.logCost(response, 'PERMISSION_PATTERNS', this.models.quickCheck, durationMs);

      this.logger.info('Permission patterns suggested', {
        durationMs,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
        toolName,
        valuePreview: valueStr.slice(0, 50),
      });

      const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : null;

      if (!text) {
        return [];
      }

      // Parse JSON array response
      let jsonText = text;

      // Strip markdown code blocks if present
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      }

      // Extract JSON array
      const jsonMatch = jsonText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        this.logger.debug('No JSON array found in pattern response', { text });
        return [];
      }

      const patterns = parseJson(jsonMatch[0]) as string[];

      // Validate patterns - ensure they're strings and not empty
      const validPatterns = patterns.filter(p => typeof p === 'string' && p.length > 0);

      // Always ensure the broadest pattern is included
      if (validPatterns.length > 0 && !validPatterns.includes(toolName)) {
        validPatterns.push(toolName);
      }

      return validPatterns;
    } catch (error) {
      this.logger.debug('Failed to suggest permission patterns', {
        error: error instanceof Error ? error.message : String(error),
        toolName,
      });
      return [];
    }
  }
}

// Export singleton instance
export const anthropicService = new AnthropicService();
