import { Router } from 'express';
import { requireTrustedOrigin } from '../../middleware/trusted-origin.js';
import { asyncHandler } from '../../middleware/error-handler.js';
import { chatgptPlanAuth, PlanError, type ChatGPTPlanAuth } from '../../services/infrastructure/chatgpt-plan-auth.js';
import { chatgptPlanClient, type ChatGPTPlanClient } from '../../services/infrastructure/chatgpt-plan-client.js';
import { ConfigService } from '../../services/infrastructure/config-service.js';
import { getCostTracker } from '../../services/infrastructure/cost-tracker.js';

export function createChatGPTPlanRoutes(auth: ChatGPTPlanAuth = chatgptPlanAuth, client: ChatGPTPlanClient = chatgptPlanClient, config = ConfigService.getInstance()): Router {
  const router = Router();
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
  router.get('/status', requireTrustedOrigin, asyncHandler(async (_request, response) => {
    response.json({ ...await auth.status(), pendingLogin: auth.pendingLogin(), routing: config.getConfig().backgroundInference ?? { provider: 'anthropic-api' }, usage: getCostTracker().getPlanUsage() });
  }));
  router.post('/login', requireTrustedOrigin, asyncHandler(async (request, response) => {
    const { accountId, enablePlan } = (request.body ?? {}) as { accountId?: string; enablePlan?: boolean };
    if (accountId !== undefined && typeof accountId !== 'string') throw new PlanError('invalid_account');
    response.json(await auth.startLogin(accountId, enablePlan === true));
  }));
  router.get('/login/:id/launch', requireTrustedOrigin, asyncHandler(async (request, response) => {
    response.set('Referrer-Policy', 'no-referrer');
    response.redirect(auth.authorizationUrl(request.params.id));
  }));
  router.post('/login/:id/callback', requireTrustedOrigin, asyncHandler(async (request, response) => {
    const { url } = (request.body ?? {}) as { url?: unknown };
    if (typeof url !== 'string' || url.length > 8192) throw new PlanError('invalid_callback_address');
    await auth.completePastedCallback(request.params.id, url);
    response.json(auth.loginStatus(request.params.id));
  }));
  router.get('/login/:id', requireTrustedOrigin, asyncHandler(async (request, response) => { response.json(auth.loginStatus(request.params.id)); }));
  router.delete('/login/:id', requireTrustedOrigin, asyncHandler(async (request, response) => { auth.cancelLogin(request.params.id); response.json({ cancelled: true }); }));
  router.post('/account', requireTrustedOrigin, asyncHandler(async (request, response) => {
    const { accountId } = (request.body ?? {}) as { accountId?: string };
    if (typeof accountId !== 'string') throw new PlanError('invalid_account');
    await auth.selectAccount(accountId); response.json(await auth.status());
  }));
  router.get('/models', requireTrustedOrigin, asyncHandler(async (_request, response) => { response.json({ models: await client.models() }); }));
  router.post('/activate', requireTrustedOrigin, asyncHandler(async (request, response) => {
    const { model } = (request.body ?? {}) as { model?: string };
    if (typeof model !== 'string' || !(await client.models()).some((candidate) => candidate.slug === model)) throw new PlanError('choose_discovered_model');
    const startedAt = Date.now();
    const completion = await client.complete(model, 'Respond briefly in plain text.', [{ role: 'user', content: 'Say: Lattice is ready.' }]);
    getCostTracker().log({ sessionId: 'chatgpt-plan-setup', operation: 'CHATGPT_PLAN_SETUP', model: completion.model, provider: 'openai', billingKind: 'chatgpt-plan', inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, cacheReadInputTokens: completion.cachedTokens, durationMs: Date.now() - startedAt });
    await auth.verifyModel(model, completion.accountId!);
    await config.updateConfig({ backgroundInference: { provider: 'chatgpt-plan', model } });
    response.json({ verified: true, model: completion.model });
  }));
  router.post('/resume', requireTrustedOrigin, asyncHandler(async (_request, response) => {
    await auth.updateActive({ paused: undefined }); response.json(await auth.status());
  }));
  router.post('/welcome', requireTrustedOrigin, asyncHandler(async (_request, response) => { await auth.updateActive({ welcomed: true }); response.json({ acknowledged: true }); }));
  router.post('/disconnect', requireTrustedOrigin, asyncHandler(async (_request, response) => { response.json(await auth.disconnect()); }));
  router.use((error: unknown, _request: import('express').Request, response: import('express').Response, next: import('express').NextFunction) => {
    if (!(error instanceof PlanError)) { next(error); return; }
    response.status(error.status).json({ code: error.code, error: error.message, requestId: error.requestId, bodyShape: error.bodyShape });
  });
  return router;
}
