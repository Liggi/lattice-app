import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { createChatGPTPlanRoutes } from '../../src/routes/integrations/chatgpt-plan.routes.js';
import { chatgptPlanAuth, PlanError, type ChatGPTPlanAuth } from '../../src/services/infrastructure/chatgpt-plan-auth.js';
import { createConfigRoutes } from '../../src/routes/system/config.routes.js';
import { errorHandler } from '../../src/middleware/error-handler.js';
import type { ChatGPTPlanClient } from '../../src/services/infrastructure/chatgpt-plan-client.js';
import type { ConfigService } from '../../src/services/infrastructure/config-service.js';

const auth = { status: vi.fn(), startLogin: vi.fn(), selectAccount: vi.fn(), verifyModel: vi.fn(), updateActive: vi.fn(), disconnect: vi.fn(), cancelLogin: vi.fn(), loginStatus: vi.fn(), completePastedCallback: vi.fn(), pendingLogin: vi.fn(() => null) };
const client = { models: vi.fn(), complete: vi.fn() };
const config = { getConfig: () => ({}), updateConfig: vi.fn() };
function app() { const server = express(); server.use(express.json()); server.use('/api/chatgpt-plan', createChatGPTPlanRoutes(auth as unknown as ChatGPTPlanAuth, client as unknown as ChatGPTPlanClient, config as unknown as ConfigService)); return supertest(server); }
beforeEach(() => {
  vi.clearAllMocks();
  auth.status.mockResolvedValue({ active: 'oaiapp_fixture', accounts: [] });
  client.models.mockResolvedValue([{ slug: 'gpt-6.1-sol', display_name: 'Sol 6.1' }]);
  client.complete.mockResolvedValue({ accountId: 'oaiapp_fixture', model: 'gpt-6.1-sol', inputTokens: 4, outputTokens: 2, cachedTokens: 0 });
});
describe('trusted-origin writes and accepted activation', () => {
  it('returns a conflict when generic config writes try to skip verified inference', async () => {
    const verification = vi.spyOn(chatgptPlanAuth, 'requireVerifiedModel').mockRejectedValueOnce(new PlanError('test_model_before_activation', 409));
    const server = express(); server.use(express.json());
    server.use('/api/config', createConfigRoutes(config as unknown as ConfigService)); server.use(errorHandler);
    const response = await supertest(server).put('/api/config').send({ backgroundInference: { provider: 'chatgpt-plan', model: 'gpt-6.1-sol' } });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('test_model_before_activation');
    expect(config.updateConfig).not.toHaveBeenCalled();
    verification.mockRestore();
  });
  it.each(['/login', '/activate', '/account', '/resume', '/welcome', '/disconnect'])('rejects cross-origin %s before any side effect', async (route) => {
    const response = await app().post(`/api/chatgpt-plan${route}`).set('Origin', 'https://attacker.invalid').set('Sec-Fetch-Site', 'cross-site').send({ model: 'gpt-6.1-sol', accountId: 'oaiapp_fixture' });
    expect(response.status).toBe(403);
    expect(config.updateConfig).not.toHaveBeenCalled();
    expect(auth.startLogin).not.toHaveBeenCalled();
    expect(client.complete).not.toHaveBeenCalled();
  });
  it('starts sign-in from a remote browser and finishes it from the pasted callback address', async () => {
    auth.startLogin.mockResolvedValue({ id: 'attempt', launchPath: '/api/chatgpt-plan/login/attempt/launch' });
    auth.loginStatus.mockReturnValue({ phase: 'complete' });
    expect((await app().post('/api/chatgpt-plan/login').set('Host', 'mini.tailnet.invalid').send({})).status).toBe(200);
    const pasted = 'http://127.0.0.1:5555/auth/callback?code=c&state=s';
    const response = await app().post('/api/chatgpt-plan/login/attempt/callback').set('Host', 'mini.tailnet.invalid').send({ url: pasted });
    expect(response.body).toEqual({ phase: 'complete' });
    expect(auth.completePastedCallback).toHaveBeenCalledWith('attempt', pasted);
    auth.completePastedCallback.mockRejectedValueOnce(new PlanError('invalid_oauth_state'));
    const rejected = await app().post('/api/chatgpt-plan/login/attempt/callback').send({ url: pasted });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe('invalid_oauth_state');
    expect((await app().post('/api/chatgpt-plan/login/attempt/callback').set('Origin', 'https://attacker.invalid').set('Sec-Fetch-Site', 'cross-site').send({ url: pasted })).status).toBe(403);
    expect(auth.completePastedCallback).toHaveBeenCalledTimes(2);
  });
  it('rejects an undiscovered model and never activates on partial/failed inference', async () => {
    expect((await app().post('/api/chatgpt-plan/activate').send({ model: 'not-entitled' })).status).toBe(400);
    client.complete.mockRejectedValueOnce(new PlanError('stream_ended_without_completion', 502));
    expect((await app().post('/api/chatgpt-plan/activate').send({ model: 'gpt-6.1-sol' })).status).toBe(502);
    expect(config.updateConfig).not.toHaveBeenCalled();
    expect(auth.verifyModel).not.toHaveBeenCalled();
  });
  it('activates only after completed inference and account binding; preserves all feature opt-ins', async () => {
    const response = await app().post('/api/chatgpt-plan/activate').send({ model: 'gpt-6.1-sol' });
    expect(response.status).toBe(200);
    expect(auth.verifyModel).toHaveBeenCalledWith('gpt-6.1-sol', 'oaiapp_fixture');
    expect(config.updateConfig).toHaveBeenCalledWith({ backgroundInference: { provider: 'chatgpt-plan', model: 'gpt-6.1-sol' } });
    expect(response.body).toEqual({ verified: true, model: 'gpt-6.1-sol' });
  });
  it('does not activate if the selected account changes during the verification request', async () => {
    auth.verifyModel.mockRejectedValueOnce(new PlanError('account_changed_during_verification', 409));
    const response = await app().post('/api/chatgpt-plan/activate').send({ model: 'gpt-6.1-sol' });
    expect(response.status).toBe(409);
    expect(config.updateConfig).not.toHaveBeenCalled();
  });
});
