/**
 * Model survival across process replacement.
 *
 * A worker dispatched on claude-fable-5-1 came back as claude-opus-5[1m]: its
 * `/send` cold reconstruction passed `--model` only when the caller named one,
 * so a recovery with no override spawned the CLI bare and it took the account
 * default. `run:ready` then truthfully recorded the substituted model, which is
 * why the loss looked like a choice.
 *
 * All three replacement paths now resolve the model the same way a lifecycle
 * resume does. The legacy "unknown" sentinel still passes no model at all, so a
 * conversation from before the harness recorded one keeps deferring to Claude's
 * own configured default rather than being pinned to a guess.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { SessionManager } from '@liggi/agent-ui-harness/server';
import { createHarnessRoutes } from '../../src/harness/routes.js';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';

beforeEach(async () => {
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
  await new SessionInfoService(':memory:').initialize();
  ConversationService.getInstance().initialize(DatabaseProvider.getInstance().getDb());
});
afterEach(() => {
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
});

/**
 * A conversation whose segment records what it last actually ran on. Creation
 * writes the "unknown" sentinel for Claude; `run:ready` replaces it, which is
 * what `model` here stands in for.
 */
function conversationOn(model: string | null, provider: 'claude' | 'codex' = 'claude'): string {
  const service = ConversationService.getInstance();
  const { conversationId } = service.createConversation({
    workingDirectory: '/tmp/project',
    provider,
    providerSessionId: 'provider-session-1',
    model: 'unknown',
  });
  if (model) service.updateLatestSegmentModel(conversationId, model);
  return conversationId;
}

function build(opts: { sendError?: string; compactError?: string } = {}) {
  const start = vi.fn(async () => ({ runId: 'run-1', processId: 'process-1' }));
  const send = vi.fn(async () => {
    if (opts.sendError) throw new Error(opts.sendError);
  });
  const compact = vi.fn(async () => {
    if (opts.compactError) throw new Error(opts.compactError);
  });
  const sessionManager = {
    start,
    send,
    compact,
    getLog: () => null,
    countInStorage: () => 0,
    inspect: () => null,
    readFromStorage: () => [],
  } as unknown as SessionManager;

  const app = express();
  app.use(express.json());
  app.use('/api/harness', createHarnessRoutes(sessionManager, {
    resolveResumeSessionId: () => 'provider-session-1',
    resolveProvider: () => 'claude',
    resolveWorkingDirectory: () => '/tmp/project',
  }));

  return { app, start, send, compact };
}

/** The `--model=` the route actually handed the process, if any. */
function modelArg(start: ReturnType<typeof vi.fn>): string | undefined {
  const args = (start.mock.calls[0]?.[1] as { args?: string[] } | undefined)?.args;
  return args?.find(arg => arg.startsWith('--model='))?.slice('--model='.length);
}

describe('/send cold reconstruction', () => {
  for (const failure of ['Unknown session', 'Session config not available']) {
    it(`keeps the conversation on its own model after "${failure}"`, async () => {
      const { app, start } = build({ sendError: failure });
      const conversationId = conversationOn('claude-fable-5-1');

      const res = await request(app)
        .post(`/api/harness/${conversationId}/send`)
        .send({ input: 'carry on' });

      expect(res.status).toBe(200);
      expect(res.body.recovered).toBe(true);
      expect(modelArg(start)).toBe('claude-fable-5-1');
    });
  }

  it('lets an explicitly requested model win over the recorded one', async () => {
    const { app, start } = build({ sendError: 'Unknown session' });
    const conversationId = conversationOn('claude-fable-5-1');

    await request(app)
      .post(`/api/harness/${conversationId}/send`)
      .send({ input: 'switch me', model: 'claude-opus-5-5[1m]' });

    expect(modelArg(start)).toBe('claude-opus-5-5[1m]');
  });

  it('refuses a superseded requested model and starts nothing', async () => {
    const { app, start, send } = build({ sendError: 'Unknown session' });
    const conversationId = conversationOn('claude-fable-5-1');

    const res = await request(app)
      .post(`/api/harness/${conversationId}/send`)
      .send({ input: 'switch me', model: 'claude-opus-5' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('use claude-opus-5-5');
    expect(send).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('keeps a conversation already on a superseded model running on it', async () => {
    const { app, start } = build({ sendError: 'Unknown session' });
    const conversationId = conversationOn('claude-opus-5');

    const res = await request(app)
      .post(`/api/harness/${conversationId}/send`)
      .send({ input: 'carry on' });

    expect(res.status).toBe(200);
    expect(modelArg(start)).toBe('claude-opus-5');
  });

  it('passes no model for a legacy segment that never recorded one', async () => {
    const { app, start } = build({ sendError: 'Unknown session' });
    const conversationId = conversationOn(null);

    await request(app)
      .post(`/api/harness/${conversationId}/send`)
      .send({ input: 'carry on' });

    // Claude's configured default is the right answer when nothing is known;
    // substituting one here is what the fix is trying to stop.
    expect(modelArg(start)).toBeUndefined();
  });
});

describe('/start process replacement', () => {
  it('keeps the conversation on its own model when none is requested', async () => {
    const { app, start } = build();
    const conversationId = conversationOn('claude-fable-5-1');

    const res = await request(app)
      .post(`/api/harness/${conversationId}/start`)
      .send({ prompt: 'carry on' });

    expect(res.status).toBe(200);
    expect(modelArg(start)).toBe('claude-fable-5-1');
  });

  it('lets an explicitly requested model win', async () => {
    const { app, start } = build();
    const conversationId = conversationOn('claude-fable-5-1');

    await request(app)
      .post(`/api/harness/${conversationId}/start`)
      .send({ prompt: 'switch me', model: 'claude-opus-5-5[1m]' });

    expect(modelArg(start)).toBe('claude-opus-5-5[1m]');
  });

  it('passes no model for a legacy segment that never recorded one', async () => {
    const { app, start } = build();
    const conversationId = conversationOn(null);

    await request(app)
      .post(`/api/harness/${conversationId}/start`)
      .send({ prompt: 'carry on' });

    expect(modelArg(start)).toBeUndefined();
  });
});

describe('cold /compact reconstruction', () => {
  it('compacts on the model the conversation is running, not a default', async () => {
    const { app, start } = build({ compactError: 'Unknown session' });
    const conversationId = conversationOn('claude-fable-5-1');

    const res = await request(app).post(`/api/harness/${conversationId}/compact`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, recovered: true });
    expect(modelArg(start)).toBe('claude-fable-5-1');
  });

  it('passes no model for a legacy segment that never recorded one', async () => {
    const { app, start } = build({ compactError: 'Unknown session' });
    const conversationId = conversationOn(null);

    await request(app).post(`/api/harness/${conversationId}/compact`);

    expect(modelArg(start)).toBeUndefined();
  });
});
