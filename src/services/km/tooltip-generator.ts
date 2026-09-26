/**
 * One-paragraph explanations of an article's bold concepts.
 *
 * One model call per concept, all in flight at once. That is more calls than a
 * single "explain all of these" request, but a batched call fails whole: one
 * malformed entry in the response and every tooltip is lost. Per-concept, a
 * failure costs exactly that concept — the rest of the article still gets
 * tooltips, and the next request retries only what is missing.
 *
 * Haiku-tier, because each output is two short paragraphs about a term the
 * article already uses in passing. The model id follows the same
 * `anthropic.models.quickCheck` config override the insight service reads, so
 * pointing that at a different model moves these calls with it.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { LatticeError } from '@/types/index.js';
import { createLogger, type Logger } from '../infrastructure/logger.js';
import { ConfigService } from '../infrastructure/config-service.js';
import { anthropicClientFactory } from '../infrastructure/anthropic-client-factory.js';
import { parseJson } from '../../utils/json.js';
import { CONFIG_FILE } from '@/utils/constants.js';

/**
 * Fallback when `anthropic.models.quickCheck` is unset. Mirrors
 * `DEFAULT_MODELS.quickCheck` in services/insights/anthropic-service.ts — that
 * field is private, so until it gets a getter the two literals move together.
 *
 * This is the newest Haiku, not a forward-copied string: checked against
 * `GET /v1/models` on 2026-08-31, where 4.5 is still the only Haiku listed.
 * stale-model-ok
 */
const DEFAULT_TOOLTIP_MODEL = 'claude-haiku-4-5-20251001';

const MAX_OUTPUT_TOKENS = 1024;

/**
 * Pinned off for the same reason every other model call in this repo pins it
 * off: on the 5-family an omitted `thinking` means adaptive thinking is ON, and
 * a 1024-token cap spent on thinking returns an empty body with no error.
 * Explaining a term the article already uses is not a reasoning task.
 */
const THINKING: Anthropic.ThinkingConfigParam = { type: 'disabled' };

export interface TooltipGenerationInput {
  concepts: string[];
  title: string;
  content_md: string;
}

export interface TooltipGenerationResult {
  /** Only the concepts that succeeded. A failed concept is simply absent. */
  tooltips: Record<string, string>;
  failed: string[];
}

/** Injectable so routes and tests can drive the endpoint without a model. */
export interface TooltipGenerator {
  generate(input: TooltipGenerationInput): Promise<TooltipGenerationResult>;
}

/**
 * The prompt from the app this was ported from, with the article's title
 * standing in for that app's `subject`. The h3 header, the two-paragraph
 * ceiling and the "don't reference the article" rule are all load-bearing: the
 * result renders inside a hover card next to the term, with no surrounding page.
 */
export function createTooltipPrompt(
  concept: string,
  title: string,
  articleContent: string,
): string {
  return `You are helping explain a concept in the context of learning about ${title}.

Here is the full article content for context:

${articleContent}

Create a concise, standalone explanation for the concept "${concept}". Use the article content to understand the specific context and level of detail needed, but write the explanation as a self-contained definition that doesn't explicitly reference the article. The tooltip should:

1. Start with an ### h3 header that serves as a title for the concept (this can be different from the concept name)
2. Provide a clear, concise explanation of the concept appropriate for someone learning about ${title}
3. Include why it's important or how it's commonly used in this domain
4. Match the complexity level and perspective presented in the provided context

Format requirements:
- Begin with an ### h3 header as a title
- Keep explanation to one or two short paragraphs
- Use **bold** for important terms or phrases
- Keep the total length concise but informative
- Write as a standalone explanation (don't say "this article explains" or "as mentioned above")

IMPORTANT: Your response MUST be a valid JSON object with the following structure:
{
  "tooltip": "### Concept Title\\n\\nMarkdown formatted explanation..."
}

Do not include any text outside of this JSON structure. The response should be parseable by JSON.parse() without any modifications.`;
}

/** Pulls the `tooltip` string out of a response that may be fenced or padded. */
function readTooltip(text: string): string | null {
  const candidate = text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try {
    const parsed = parseJson(candidate) as { tooltip?: unknown };
    const tooltip = typeof parsed.tooltip === 'string' ? parsed.tooltip.trim() : '';
    return tooltip === '' ? null : tooltip;
  } catch {
    return null;
  }
}

export class AnthropicTooltipGenerator implements TooltipGenerator {
  private logger: Logger;

  constructor() {
    this.logger = createLogger('KmTooltipGenerator');
  }

  /**
   * `getConfig()` throws when the config service has not been initialized, so
   * this guards the same way AnthropicClientFactory.tryGetConfig does. A model
   * id is not worth failing a request over — and the factory has already
   * resolved credentials by this point, so an uninitialized config here means
   * "no override", not "no way to call anything".
   */
  private model(): string {
    let configured: string | undefined;
    try {
      configured = ConfigService.getInstance().getConfig().anthropic?.models?.quickCheck;
    } catch {
      configured = undefined;
    }
    return configured ?? DEFAULT_TOOLTIP_MODEL;
  }

  /**
   * Throws only when there is no way to call a model at all. A concept the
   * model refused, truncated or wrapped in prose is reported in `failed` and
   * costs nothing else — the caller keeps the tooltips that did come back.
   */
  async generate(input: TooltipGenerationInput): Promise<TooltipGenerationResult> {
    const client = anthropicClientFactory.getClient();
    if (!client) {
      throw new LatticeError(
        'ANTHROPIC_API_KEY_MISSING',
        'Tooltip generation needs an Anthropic API key. Set anthropic.apiKey in '
          + `${CONFIG_FILE}, or sign in to use the Lattice proxy.`,
        400,
      );
    }

    const model = this.model();
    const startedAt = Date.now();

    const settled = await Promise.all(input.concepts.map(async (concept) => {
      try {
        const response = await client.messages.create({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          thinking: THINKING,
          messages: [{
            role: 'user',
            content: createTooltipPrompt(concept, input.title, input.content_md),
          }],
        });

        const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
        const tooltip = readTooltip(text);
        if (!tooltip) {
          this.logger.warn('Tooltip response was not usable', {
            concept,
            stopReason: response.stop_reason,
            preview: text.slice(0, 200),
          });
          return { concept, tooltip: null };
        }
        return { concept, tooltip };
      } catch (error) {
        this.logger.warn('Tooltip generation failed for concept', {
          concept,
          error: error instanceof Error ? error.message : String(error),
        });
        return { concept, tooltip: null };
      }
    }));

    const tooltips: Record<string, string> = {};
    const failed: string[] = [];
    for (const result of settled) {
      if (result.tooltip) tooltips[result.concept] = result.tooltip;
      else failed.push(result.concept);
    }

    this.logger.info('Tooltip generation completed', {
      model,
      requested: input.concepts.length,
      generated: Object.keys(tooltips).length,
      failed: failed.length,
      durationMs: Date.now() - startedAt,
    });

    return { tooltips, failed };
  }
}
