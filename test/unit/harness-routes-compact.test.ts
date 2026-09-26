import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { SessionManager } from '@liggi/agent-ui-harness/server';
import { createHarnessRoutes } from '../../src/harness/routes.js';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';

// A cold compact reads the segment for the model the conversation is running
// at, so the route needs a database the same way production has one.
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

function build(compactImpl: SessionManager['compact'] = async () => {}) {
  const compact = vi.fn(compactImpl);
  const start = vi.fn(async () => ({ runId: 'run-1', processId: 'process-1' }));
  const sessionManager = {
    compact,
    start,
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

  return { app, compact, start };
}

describe('harness compact route', () => {
  it('invokes the provider-neutral SessionManager action', async () => {
    const { app, compact } = build();

    const response = await request(app).post('/api/harness/conv-test/compact');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(compact).toHaveBeenCalledWith('conv-test');
  });

  it('returns a conflict while another turn is active', async () => {
    const { app } = build(async () => {
      throw new Error('Cannot compact while session is streaming');
    });

    const response = await request(app).post('/api/harness/conv-test/compact');

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('streaming');
  });

  it('recovers a cold harness session as an internal compact command', async () => {
    const { app, start } = build(async () => {
      throw new Error('Unknown session');
    });

    const response = await request(app).post('/api/harness/conv-test/compact');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, recovered: true });
    expect(start.mock.calls[0][1]).toMatchObject({
      prompt: '/compact',
      cwd: '/tmp/project',
      resume: 'provider-session-1',
      extra: {
        sessionId: 'conv-test',
        provider: 'claude',
        internalCommand: 'compact',
        inputSource: 'command',
      },
    });
  });
});
