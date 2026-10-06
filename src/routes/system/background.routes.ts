import { Router } from 'express';
import { requireTrustedOrigin } from '../../middleware/trusted-origin.js';
import { asyncHandler } from '../../middleware/error-handler.js';
import { backgroundTextClient, planStandInStatus } from '../../services/infrastructure/background-text-client.js';
import { DEFAULT_MODELS } from '../../services/insights/anthropic-service.js';
import { BACKGROUND_JOBS, type BackgroundRoute } from '../../types/config.js';
import { isGenerationEnabled } from '../../services/infrastructure/generation-gates.js';

/** What Settings shows about background calls beyond the saved config, and its test button. */
export function createBackgroundRoutes(): Router {
  const router = Router();
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
  router.get('/status', requireTrustedOrigin, (_request, response) => {
    // `enabled` answers each job's switch as the gate does, defaults included.
    response.json({ planStandIn: planStandInStatus(), enabled: Object.fromEntries(BACKGROUND_JOBS.map((job) => [job, isGenerationEnabled(job)])) });
  });
  router.post('/test', requireTrustedOrigin, asyncHandler(async (request, response) => {
    const route = (request.body as { route?: BackgroundRoute } | undefined)?.route;
    if (!route || !['anthropic-api', 'chatgpt-plan', 'endpoint'].includes(route.provider)) {
      response.status(400).json({ error: 'Name a route to test' });
      return;
    }
    try {
      response.json(await backgroundTextClient.test(route, DEFAULT_MODELS.quickCheck));
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  }));
  return router;
}
