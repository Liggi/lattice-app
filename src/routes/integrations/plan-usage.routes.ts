import { Router } from 'express';
import { requireTrustedOrigin } from '../../middleware/trusted-origin.js';
import { asyncHandler } from '../../middleware/error-handler.js';
import { claudePlanUsage, type ClaudePlanUsageService } from '../../services/infrastructure/claude-plan-usage.js';
import { geminiPlanUsage, type GeminiPlanUsageService } from '../../services/infrastructure/gemini-plan-usage.js';
import { geminiSpend } from '../../services/infrastructure/gemini-spend.js';
import { ConfigService } from '../../services/infrastructure/config-service.js';

export type GeminiMode = 'plan' | 'api';

/** `api` when agy bills a Google Cloud project per token; `plan` when it uses its own sign-in and plan quota. */
function configuredGeminiMode(): GeminiMode {
  return ConfigService.getInstance().getConfig().antigravity?.googleCloudProject?.trim() ? 'api' : 'plan';
}

/**
 * Claude and Gemini plan usage from their CLIs, read in parallel, and an
 * estimate of Gemini API spend from Lattice's own turn token counts. The
 * Gemini plan is only read in plan mode.
 */
export function createPlanUsageRoutes(
  claude: ClaudePlanUsageService = claudePlanUsage,
  gemini = geminiSpend,
  geminiPlan: GeminiPlanUsageService = geminiPlanUsage,
  geminiMode: () => GeminiMode = configuredGeminiMode,
): Router {
  const router = Router();
  router.get('/', requireTrustedOrigin, asyncHandler(async (_request, response) => {
    response.set('Cache-Control', 'no-store');
    const mode = geminiMode();
    const [claudeUsage, geminiPlanUsageNow] = await Promise.all([claude.get(), mode === 'plan' ? geminiPlan.get() : undefined]);
    response.json({ claude: claudeUsage, gemini: gemini(), geminiMode: mode, ...(geminiPlanUsageNow ? { geminiPlan: geminiPlanUsageNow } : {}) });
  }));
  return router;
}
