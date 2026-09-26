/**
 * Resume pre-flight contract.
 *
 * Claude keeps resume state in its own transcript and prunes it after
 * cleanupPeriodDays. Resuming a pruned session makes the CLI print
 * "No conversation found with session ID: …" and exit 1 within a second, and
 * that arrives as an ordinary finished turn — so the conversation sits idle
 * forever with nothing shown. POST /start refuses up front instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { SessionManager } from '@liggi/agent-ui-harness/server';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';
import { createHarnessRoutes } from '../../src/harness/routes.js';

// /send checks the session's inbox before writing, and a Codex route reads
// the segment for the effort it is running at, so both need a database.
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

const PROVIDER_SESSION = 'b968e792-8898-4d1e-9c1a-000000000000';

function build(opts: {
  transcript?: 'present' | 'missing' | 'unknown' | undefined;
  provider?: 'claude' | 'codex';
  resumeId?: string;
  /** null = no live session, matching SessionManager.inspect() */
  inspect?: { processAlive: boolean; resumeId: string | null } | null;
} = {}) {
  const start = vi.fn(async () => ({ runId: 'run-1', processId: 'sdk-1' }));
  const send = vi.fn(async () => {});
  const sessionManager = {
    start,
    send,
    getLog: () => null,
    countInStorage: () => 0,
    inspect: () => opts.inspect ?? null,
    readFromStorage: () => [],
  } as unknown as SessionManager;

  const classifyResumeTranscript = opts.transcript === undefined
    ? undefined
    : vi.fn(async () => opts.transcript as 'present' | 'missing' | 'unknown');

  const app = express();
  app.use(express.json());
  app.use(
    '/api/harness',
    createHarnessRoutes(sessionManager, {
      resolveResumeSessionId: () => opts.resumeId ?? PROVIDER_SESSION,
      resolveProvider: () => opts.provider ?? 'claude',
      resolveWorkingDirectory: () => '/tmp',
      ...(classifyResumeTranscript ? { classifyResumeTranscript } : {}),
    }),
  );

  return { app, start, send, classifyResumeTranscript };
}

describe('harness routes — resume pre-flight', () => {
  it('refuses to start when the provider transcript has been pruned', async () => {
    const { app, start } = build({ transcript: 'missing' });

    const res = await request(app).post('/api/harness/conv-abc/start').send({ prompt: 'carry on' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RESUME_TRANSCRIPT_MISSING');
    // The point of the check: never spawn a process that cannot succeed.
    expect(start).not.toHaveBeenCalled();
  });

  it('explains what happened rather than returning a bare code', async () => {
    const { app } = build({ transcript: 'missing' });
    const res = await request(app).post('/api/harness/conv-abc/start').send({ prompt: 'carry on' });
    expect(res.body.error).toMatch(/transcript/i);
    expect(res.body.error).toMatch(/new conversation/i);
  });

  it('starts normally when the transcript is still on disk', async () => {
    const { app, start } = build({ transcript: 'present' });

    const res = await request(app).post('/api/harness/conv-abc/start').send({ prompt: 'carry on' });

    expect(res.status).toBe(200);
    expect(start).toHaveBeenCalled();
  });

  // Codex resumes by thread ID, not a Claude transcript, so the check must not apply.
  it('does not apply the transcript check to codex conversations', async () => {
    const { app, start, classifyResumeTranscript } = build({ transcript: 'missing', provider: 'codex' });

    const res = await request(app).post('/api/harness/conv-abc/start').send({ prompt: 'carry on' });

    expect(res.status).toBe(200);
    expect(start).toHaveBeenCalled();
    expect(classifyResumeTranscript).not.toHaveBeenCalled();
  });

  // A fresh conversation has no resume target; resolveResumeSessionId returns
  // the conversationId unchanged to signal that.
  it('does not check anything when there is nothing to resume', async () => {
    const { app, start, classifyResumeTranscript } = build({ transcript: 'missing', resumeId: 'conv-abc' });

    const res = await request(app).post('/api/harness/conv-abc/start').send({ prompt: 'first message' });

    expect(res.status).toBe(200);
    expect(start).toHaveBeenCalled();
    expect(classifyResumeTranscript).not.toHaveBeenCalled();
  });

  // The whole point of the three-valued result. `claudeHomePath` is hardcoded
  // to ~/.claude and ignores CLAUDE_CONFIG_DIR, so on a machine whose
  // transcripts live elsewhere every lookup misses. Treating that as "pruned"
  // would refuse every message the user sends — far worse than the silent idle
  // this guard exists to prevent. Fail open.
  it('starts when the transcript store cannot be read at all', async () => {
    const { app, start } = build({ transcript: 'unknown' });

    const res = await request(app).post('/api/harness/conv-abc/start').send({ prompt: 'carry on' });

    expect(res.status).toBe(200);
    expect(start).toHaveBeenCalled();
  });

  // The resolver is optional, so an embedder that omits it keeps working.
  it('starts when no transcript resolver is wired', async () => {
    const { app, start } = build({ transcript: undefined });

    const res = await request(app).post('/api/harness/conv-abc/start').send({ prompt: 'carry on' });

    expect(res.status).toBe(200);
    expect(start).toHaveBeenCalled();
  });
});

/**
 * The reported failure came through /send, not /start: the session already
 * existed and its process had exited, so SessionManager.send() respawned the
 * run with --resume instead of writing to stdin.
 */
describe('harness routes — resume pre-flight on /send', () => {
  it('refuses when the process is dead and the transcript is gone', async () => {
    const { app, send } = build({
      transcript: 'missing',
      inspect: { processAlive: false, resumeId: PROVIDER_SESSION },
    });

    const res = await request(app).post('/api/harness/conv-abc/send').send({ input: 'carry on' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RESUME_TRANSCRIPT_MISSING');
    expect(send).not.toHaveBeenCalled();
  });

  // A live process is written to over stdin and never resumes, so the check
  // must not fire — blocking here would break healthy conversations.
  it('lets a live process through even when no transcript exists', async () => {
    const { app, send, classifyResumeTranscript } = build({
      transcript: 'missing',
      inspect: { processAlive: true, resumeId: PROVIDER_SESSION },
    });

    const res = await request(app).post('/api/harness/conv-abc/send').send({ input: 'carry on' });

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalled();
    expect(classifyResumeTranscript).not.toHaveBeenCalled();
  });

  it('sends normally when the process is dead but the transcript survives', async () => {
    const { app, send } = build({
      transcript: 'present',
      inspect: { processAlive: false, resumeId: PROVIDER_SESSION },
    });

    const res = await request(app).post('/api/harness/conv-abc/send').send({ input: 'carry on' });

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalled();
  });

  it('sends normally when the transcript store cannot be read at all', async () => {
    const { app, send } = build({
      transcript: 'unknown',
      inspect: { processAlive: false, resumeId: PROVIDER_SESSION },
    });

    const res = await request(app).post('/api/harness/conv-abc/send').send({ input: 'carry on' });

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalled();
  });

  it('sends normally when the harness has no session to inspect', async () => {
    const { app, send } = build({ transcript: 'missing', inspect: null });

    const res = await request(app).post('/api/harness/conv-abc/send').send({ input: 'carry on' });

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalled();
  });

  // A dead process with no resumeId spawns fresh rather than resuming.
  it('sends normally when there is no resume target', async () => {
    const { app, send, classifyResumeTranscript } = build({
      transcript: 'missing',
      inspect: { processAlive: false, resumeId: null },
    });

    const res = await request(app).post('/api/harness/conv-abc/send').send({ input: 'carry on' });

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalled();
    expect(classifyResumeTranscript).not.toHaveBeenCalled();
  });
});
