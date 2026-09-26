import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Modality } from '@google/genai';
import sharp from 'sharp';
import { LatticeError } from '@/types/index.js';
import { createLogger, type Logger } from '@/services/infrastructure/logger.js';
import { ConfigService } from '@/services/infrastructure/config-service.js';
import { allowGeneration } from '@/services/infrastructure/generation-gates.js';
import { getCostTracker } from '@/services/infrastructure/cost-tracker.js';
import { CONFIG_FILE } from '@/utils/constants.js';

// Pre-generated banner pool — 620 Gemini 3 Pro images (401×64), randomly assigned to sessions.
// No API call needed. ~5MB total on disk.
const BANNER_POOL: string[] = [];
function loadBannerPool(): void {
  if (BANNER_POOL.length > 0) return;
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const projectRoot = join(thisDir, '..', '..');
    const bannerDir = join(projectRoot, 'data', 'banners');
    const files = readdirSync(bannerDir).filter(f => f.endsWith('.jpg')).sort();
    for (const file of files) {
      const buf = readFileSync(join(bannerDir, file));
      BANNER_POOL.push(buf.toString('base64'));
    }
  } catch {
    // Pool not found — will fall back to empty, callers handle gracefully
  }
}

export interface GeminiImageResponse {
  imageData: string;  // base64 encoded JPEG
  mimeType: string;
}

// ─── Consultation Types ───────────────────────────────────────────────────

export type ConsultMode = 'analysis' | 'review' | 'architect' | 'freeform';

export interface ConsultationRequest {
  mode: ConsultMode;
  question?: string;  // Required for 'freeform' mode
}

export interface ConsultationResult {
  mode: ConsultMode;
  question?: string;
  response: string;
  model: string;
  elapsedMs: number;
  tokens: {
    input: number;
    output: number;
    thinking: number;
  };
  estimatedCostUsd: number;
}

const CONSULT_MODEL = 'gemini-3.1-pro-preview';
const CHARACTER_IMAGE_MODEL = 'gemini-3.1-flash-image';

const CONSULT_PROMPTS: Record<string, string> = {
  analysis: `You are an expert software engineering consultant reviewing a coding session transcript.

Provide a thorough analysis covering:

1. **Session Summary** — What was accomplished? What was the goal and did they achieve it?
2. **Key Decisions** — What important technical decisions were made? Were they sound?
3. **What Went Well** — Highlight effective patterns, good debugging approaches, or clean implementations.
4. **Friction Points** — Where did the session get stuck, go in circles, or make suboptimal choices?
5. **Missed Opportunities** — Anything the developer (or their AI assistant) overlooked?
6. **Recommendations** — Concrete, actionable suggestions for improvement.

Be direct and specific. Reference actual code and decisions from the transcript. Don't pad with generalities.`,

  review: `You are a senior code reviewer analyzing a coding session.

Focus on the CODE that was written or modified during this session:

1. **Code Quality** — Is the code clean, readable, and well-structured? Any code smells?
2. **Error Handling** — Are edge cases covered? Is error handling appropriate?
3. **Security** — Any potential security issues (injection, XSS, auth gaps)?
4. **Performance** — Any performance concerns (N+1 queries, unnecessary re-renders, blocking operations)?
5. **Testing** — Was testing adequate? What test coverage gaps exist?
6. **Architecture** — Does the code fit well into the existing architecture?

Be specific — quote actual code patterns you see in the transcript. Prioritize issues by severity.`,

  architect: `You are a principal software architect reviewing a coding session to evaluate design decisions.

Analyze the architectural aspects:

1. **Design Patterns** — What patterns are being used? Are they appropriate for this context?
2. **Coupling & Cohesion** — How well-separated are concerns? Any inappropriate dependencies?
3. **Scalability** — Will this approach hold up as the system grows?
4. **Maintainability** — How easy will this be for someone else to understand and modify?
5. **Trade-offs** — What trade-offs were made (implicitly or explicitly)? Were they the right ones?
6. **Technical Debt** — Is any being introduced? Is any being paid down?

Think long-term. Consider both the immediate changes and their implications for the broader system.`,
};

/**
 * Provides session identity images from a pre-generated static pool,
 * and Gemini 3.1 Pro consultation for session analysis.
 */
export class GeminiService {
  private logger: Logger;
  private genai: GoogleGenAI | null = null;

  constructor() {
    this.logger = createLogger('GeminiService');
  }

  async initialize(): Promise<void> {
    loadBannerPool();
    this.logger.info('Banner pool loaded', { poolSize: BANNER_POOL.length });

    // Initialize Gemini API client for consultation
    const config = ConfigService.getInstance().getConfig();
    const apiKey = config.gemini?.apiKey || process.env.GOOGLE_API_KEY;
    if (apiKey) {
      this.genai = new GoogleGenAI({ apiKey });
      this.logger.info('Gemini consultation initialized', { model: CONSULT_MODEL });
    } else {
      this.logger.info('Gemini API key not configured — consultation disabled');
    }
  }

  isConsultationAvailable(): boolean {
    return this.genai !== null;
  }

  /**
   * Pick a random identity banner from the pre-generated pool.
   *
   * 620 unique Gemini 3 Pro banners (401×64 landscape), pre-generated and bundled.
   * No API key required, no latency, no cost. At 15 sessions/day a user
   * won't see a repeat for ~41 days; birthday-paradox 50% collision at ~29 days.
   */
  generateSessionImage(_sessionContext: {
    mission: string;
    project?: string;
    theme?: string;
  }): Promise<GeminiImageResponse> {
    loadBannerPool();

    if (BANNER_POOL.length === 0) {
      return Promise.reject(
        new LatticeError('BANNER_POOL_EMPTY', 'No pre-generated banners found in data/banners/', 500)
      );
    }

    const index = Math.floor(Math.random() * BANNER_POOL.length);
    this.logger.debug('Assigned banner from static pool', {
      poolSize: BANNER_POOL.length,
      index,
    });

    return Promise.resolve({
      imageData: BANNER_POOL[index],
      mimeType: 'image/jpeg',
    });
  }

  /**
   * Generate a square portrait for a pinned session character, then normalize
   * it without stretching so the stored asset has predictable proportions and size.
   */
  async generatePinnedCharacterImage(prompt: string): Promise<GeminiImageResponse> {
    if (!allowGeneration('gemini')) {
      throw new LatticeError(
        'GENERATION_DISABLED',
        `Gemini calls are off — set generation.gemini to true in ${CONFIG_FILE}`,
        503
      );
    }
    if (!this.genai) {
      throw new LatticeError(
        'GEMINI_NOT_CONFIGURED',
        `Gemini API key not configured — set gemini.apiKey in ${CONFIG_FILE}`,
        400
      );
    }

    const startedAt = Date.now();
    try {
      const response = await this.genai.models.generateContent({
        model: CHARACTER_IMAGE_MODEL,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          responseModalities: [Modality.IMAGE],
          imageConfig: {
            aspectRatio: '1:1',
            imageSize: '1K',
          },
        },
      });

      const imagePart = response.candidates
        ?.flatMap(candidate => candidate.content?.parts ?? [])
        .find(part => part.inlineData?.data && part.inlineData.mimeType?.startsWith('image/'));
      const sourceData = imagePart?.inlineData?.data;
      if (!sourceData) {
        throw new LatticeError(
          'GEMINI_CHARACTER_IMAGE_MISSING',
          'Gemini returned no character image',
          502
        );
      }

      const normalized = await sharp(Buffer.from(sourceData, 'base64'))
        .rotate()
        .resize(256, 256, {
          fit: 'contain',
          background: { r: 8, g: 12, b: 18, alpha: 1 },
        })
        .png({ compressionLevel: 9 })
        .toBuffer();

      this.logger.info('Pinned character image generated', {
        model: CHARACTER_IMAGE_MODEL,
        elapsedMs: Date.now() - startedAt,
        sourceMimeType: imagePart.inlineData?.mimeType,
        storedBytes: normalized.byteLength,
      });

      return {
        imageData: normalized.toString('base64'),
        mimeType: 'image/png',
      };
    } catch (error) {
      if (error instanceof LatticeError) throw error;
      this.logger.error('Pinned character image generation failed', {
        model: CHARACTER_IMAGE_MODEL,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new LatticeError(
        'GEMINI_CHARACTER_GENERATION_ERROR',
        `Character generation failed: ${error instanceof Error ? error.message : String(error)}`,
        502
      );
    }
  }
  // ─── Session Consultation ───────────────────────────────────────────────

  /**
   * Consult Gemini 3.1 Pro about a coding session.
   *
   * Feeds session transcript context to Gemini with thinking enabled
   * and returns a structured analysis. Supports multiple modes:
   * - analysis: General session review
   * - review: Code quality focus
   * - architect: Architectural analysis
   * - freeform: Custom question about the session
   */
  async consultSession(
    sessionContext: string,
    request: ConsultationRequest,
  ): Promise<ConsultationResult> {
    if (!allowGeneration('gemini')) {
      throw new LatticeError(
        'GENERATION_DISABLED',
        `Gemini calls are off — set generation.gemini to true in ${CONFIG_FILE}`,
        503
      );
    }
    if (!this.genai) {
      throw new LatticeError(
        'GEMINI_NOT_CONFIGURED',
        `Gemini API key not configured — set gemini.apiKey in ${CONFIG_FILE}`,
        400
      );
    }

    const { mode, question } = request;

    if (mode === 'freeform' && !question) {
      throw new LatticeError('GEMINI_MISSING_QUESTION', 'Freeform mode requires a question', 400);
    }

    const systemPrompt = mode === 'freeform'
      ? `You are an expert software engineering consultant. The user will provide a coding session transcript and ask a specific question about it. Answer thoroughly and directly, referencing specific details from the transcript.`
      : CONSULT_PROMPTS[mode];

    if (!systemPrompt) {
      throw new LatticeError('GEMINI_INVALID_MODE', `Unknown consultation mode: ${mode}`, 400);
    }

    const userPrompt = mode === 'freeform'
      ? `Here is the session transcript:\n\n${sessionContext}\n\nQuestion: ${question}`
      : `Here is the session transcript:\n\n${sessionContext}`;

    this.logger.info('Starting Gemini consultation', {
      mode,
      model: CONSULT_MODEL,
      contextLength: sessionContext.length,
      estimatedTokens: Math.round(sessionContext.length / 4),
    });

    const startTime = Date.now();

    try {
      const response = await this.genai.models.generateContent({
        model: CONSULT_MODEL,
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        config: {
          systemInstruction: systemPrompt,
          thinkingConfig: { thinkingBudget: 8192 },
          maxOutputTokens: 8192,
          temperature: 0.7,
        },
      });

      const elapsedMs = Date.now() - startTime;
      const text = response.text ?? '';
      const usage = response.usageMetadata;

      const inputTokens = usage?.promptTokenCount ?? 0;
      const outputTokens = usage?.candidatesTokenCount ?? 0;
      const thinkingTokens = (usage as Record<string, number>)?.thoughtsTokenCount ?? 0;

      // Estimate cost: $2/M input, $12/M output (≤200K context)
      const inputCost = (inputTokens / 1_000_000) * 2;
      const outputCost = (outputTokens / 1_000_000) * 12;

      this.logger.info('Gemini consultation complete', {
        mode,
        elapsedMs,
        inputTokens,
        outputTokens,
        thinkingTokens,
        estimatedCostUsd: (inputCost + outputCost).toFixed(4),
        responseLength: text.length,
      });

      // Persist it. This cost was computed and then dropped on the floor until
      // 2026-08-28 — logged to a line nothing reads, absent from the ledger.
      // Thinking tokens are billed as output, so they count here.
      this.recordSpend('GEMINI_CONSULT', CONSULT_MODEL, inputTokens, outputTokens + thinkingTokens, elapsedMs);

      return {
        mode,
        question,
        response: text,
        model: CONSULT_MODEL,
        elapsedMs,
        tokens: { input: inputTokens, output: outputTokens, thinking: thinkingTokens },
        estimatedCostUsd: inputCost + outputCost,
      };
    } catch (error) {
      const elapsedMs = Date.now() - startTime;
      this.logger.error('Gemini consultation failed', {
        mode,
        elapsedMs,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new LatticeError(
        'GEMINI_CONSULTATION_ERROR',
        `Gemini consultation failed: ${error instanceof Error ? error.message : String(error)}`,
        500
      );
    }
  }

  /**
   * Low-level Gemini call with a raw prompt and configurable options.
   * Used by SessionReviewService to run the same review prompt through Gemini.
   */
  async consultSessionRaw(
    prompt: string,
    options: {
      responseMimeType?: string;
      temperature?: number;
      maxOutputTokens?: number;
      model?: string;
    } = {},
  ): Promise<{
    response: string;
    tokens: { input: number; output: number; thinking: number };
    estimatedCostUsd: number;
  }> {
    if (!allowGeneration('gemini')) {
      throw new LatticeError(
        'GENERATION_DISABLED',
        `Gemini calls are off — set generation.gemini to true in ${CONFIG_FILE}`,
        503
      );
    }
    if (!this.genai) {
      throw new LatticeError(
        'GEMINI_NOT_CONFIGURED',
        `Gemini API key not configured — set gemini.apiKey in ${CONFIG_FILE}`,
        400
      );
    }

    const startTime = Date.now();

    const response = await this.genai.models.generateContent({
      model: options.model || CONSULT_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        thinkingConfig: { thinkingBudget: 8192 },
        maxOutputTokens: options.maxOutputTokens ?? 4096,
        temperature: options.temperature ?? 0.3,
        responseMimeType: options.responseMimeType,
      },
    });

    const elapsedMs = Date.now() - startTime;
    const text = response.text ?? '';
    const usage = response.usageMetadata;

    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;
    const thinkingTokens = (usage as Record<string, number>)?.thoughtsTokenCount ?? 0;

    const inputCost = (inputTokens / 1_000_000) * 2;
    const outputCost = (outputTokens / 1_000_000) * 12;

    this.logger.info('Gemini raw consultation complete', {
      elapsedMs,
      inputTokens,
      outputTokens,
      thinkingTokens,
      estimatedCostUsd: (inputCost + outputCost).toFixed(4),
      responseLength: text.length,
    });

    this.recordSpend(
      'GEMINI_CONSULT',
      options.model ?? CONSULT_MODEL,
      inputTokens,
      outputTokens + thinkingTokens,
      elapsedMs,
    );

    return {
      response: text,
      tokens: { input: inputTokens, output: outputTokens, thinking: thinkingTokens },
      estimatedCostUsd: inputCost + outputCost,
    };
  }

  /**
   * Write one Gemini call to the shared spend ledger.
   *
   * Never throws: a ledger failure must not take down the call it is recording.
   * That is the safe direction for a consultation, but it does mean the ledger
   * can under-report if the DB is unavailable — the daily summary says so
   * rather than presenting its total as exact.
   */
  private recordSpend(
    operation: 'GEMINI_CONSULT' | 'GEMINI_IMAGE',
    model: string,
    inputTokens: number,
    outputTokens: number,
    durationMs: number,
  ): void {
    try {
      getCostTracker().log({
        sessionId: 'gemini',
        operation,
        model,
        inputTokens,
        outputTokens,
        durationMs,
        source: 'lattice',
        provider: 'google',
      });
    } catch {
      // Ledger unavailable; the consultation still returns.
    }
  }
}

// Export singleton instance
export const geminiService = new GeminiService();
