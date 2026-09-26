/**
 * Harness route contract for composer attachments.
 *
 * POST /:sessionId/send accepts `{ input, attachments }` and forwards the
 * attachments as the harness `extra` bag, which SessionManager.send() threads to
 * ProcessHandle.write(). POST /:sessionId/start accepts `{ prompt, attachments }`
 * and puts them on SpawnConfig.extra for the first turn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { SessionManager } from '@liggi/agent-ui-harness/server';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';
import { createHarnessRoutes } from '../../src/harness/routes.js';

// The send route looks the conversation up (a coordinator's images are kept
// on disk); an unknown conversation is a plain session.
beforeEach(async () => {
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
  await new SessionInfoService(':memory:').initialize();
});
afterEach(() => {
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
});

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const IMAGE_BLOCK = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: PNG_1PX },
};

function build(overrides: {
  sendImpl?: SessionManager['send'];
  provider?: 'claude' | 'codex';
} = {}) {
  const send = vi.fn(overrides.sendImpl ?? (async () => {}));
  const start = vi.fn(async () => ({ runId: 'run-1', processId: 'sdk-1' }));

  const sessionManager = {
    send,
    start,
    getLog: () => null,
    countInStorage: () => 0,
    inspect: () => null,
    readFromStorage: () => [],
  } as unknown as SessionManager;

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(
    '/api/harness',
    createHarnessRoutes(sessionManager, {
      resolveResumeSessionId: (id) => id,
      resolveProvider: () => overrides.provider ?? 'claude',
      resolveWorkingDirectory: () => '/tmp',
    }),
  );

  return { app, send, start };
}

describe('harness routes — attachments', () => {
  it('POST /send forwards attachments as the harness extra bag', async () => {
    const { app, send } = build();

    const res = await request(app)
      .post('/api/harness/conv-abc/send')
      .send({ input: 'what is this?', attachments: [IMAGE_BLOCK] });

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith('conv-abc', 'what is this?', { attachments: [IMAGE_BLOCK] });
  });

  it('POST /send omits the extra bag entirely when there are no attachments', async () => {
    const { app, send } = build();

    const res = await request(app).post('/api/harness/conv-abc/send').send({ input: 'plain' });

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith('conv-abc', 'plain', undefined);
  });

  it('POST /send forwards Codex model and reasoning-effort overrides', async () => {
    const { app, send } = build({ provider: 'codex' });

    const res = await request(app)
      .post('/api/harness/conv-abc/send')
      .send({ input: 'switch', model: 'gpt-5.6-terra', reasoningEffort: 'ultra' });

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith('conv-abc', 'switch', {
      model: 'gpt-5.6-terra',
      reasoningEffort: 'ultra',
    });
  });

  it('POST /send rejects an unsupported media type with a 400 instead of dropping it', async () => {
    const { app, send } = build();

    const res = await request(app)
      .post('/api/harness/conv-abc/send')
      .send({
        input: 'look',
        attachments: [{ type: 'image', source: { type: 'base64', media_type: 'image/heic', data: 'AAA' } }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('image/heic');
    expect(send).not.toHaveBeenCalled();
  });

  it('POST /send accepts an attachment-only message', async () => {
    const { app, send } = build();

    const res = await request(app)
      .post('/api/harness/conv-abc/send')
      .send({ attachments: [IMAGE_BLOCK] });

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith('conv-abc', '', { attachments: [IMAGE_BLOCK] });
  });

  it('POST /send still 400s on an empty message with no attachments', async () => {
    const { app, send } = build();

    const res = await request(app).post('/api/harness/conv-abc/send').send({});

    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('POST /start puts attachments on SpawnConfig.extra', async () => {
    const { app, start } = build();

    const res = await request(app)
      .post('/api/harness/conv-abc/start')
      .send({ prompt: 'review this', model: 'claude-opus-5-5', attachments: [IMAGE_BLOCK] });

    expect(res.status).toBe(200);
    const config = start.mock.calls[0][1] as { prompt: string; extra: Record<string, unknown> };
    expect(config.prompt).toBe('review this');
    expect(config.extra.attachments).toEqual([IMAGE_BLOCK]);
  });

  it('POST /start puts Codex reasoning effort on SpawnConfig.extra', async () => {
    const { app, start } = build({ provider: 'codex' });

    const res = await request(app)
      .post('/api/harness/conv-abc/start')
      .send({ prompt: 'start', model: 'gpt-5.6-terra', reasoningEffort: 'max' });

    expect(res.status).toBe(200);
    const config = start.mock.calls[0][1] as { extra: Record<string, unknown> };
    expect(config.extra).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'max',
    });
  });

  it('the auto-recovery respawn on /send carries attachments into the new run', async () => {
    const { app, start } = build({
      sendImpl: (async () => {
        throw new Error('Unknown session');
      }) as unknown as SessionManager['send'],
    });

    const res = await request(app)
      .post('/api/harness/conv-abc/send')
      .send({ input: 'recovered turn', attachments: [IMAGE_BLOCK] });

    expect(res.status).toBe(200);
    expect(res.body.recovered).toBe(true);
    const config = start.mock.calls[0][1] as { prompt: string; extra: Record<string, unknown> };
    expect(config.prompt).toBe('recovered turn');
    expect(config.extra.attachments).toEqual([IMAGE_BLOCK]);
  });
});
