/**
 * A completed worker is a normal destination: a coordinator's report link
 * stays clickable after the worker is archived. Archived conversations are
 * not in the sidebar list, so the view saw no `pickedUpFrom` for one and
 * treated it as an ordinary session — no way back to its project, and the
 * Mission / History panel a worker is not supposed to have.
 *
 * The details route now carries the persisted parent, and the view resolves
 * list-then-details for both the panel gate and the Back destination.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { Router } from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';
import { registerUnifiedConversationQueryRoutes } from '../../src/routes/conversation/unified-conversation.query-routes.js';
import { initEventMessageReader } from '../../src/harness/event-message-reader.js';
import {
  resolveIsArchived,
  resolveIsCoordinator,
  resolveParentConversationId,
} from '../../src/web/chat/utils/session-identity.js';

// The details route reads messages; these conversations have none, and the
// parent is metadata that does not depend on them.
initEventMessageReader({ readTail: () => [] } as never);

describe('an archived worker, absent from the conversations list', () => {
  let app: express.Express;
  let workerId: string;
  let projectId: string;
  let configDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(async () => {
    // Keep the database off the real config directory.
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-worker-parent-'));
    previousConfigDir = process.env.LATTICE_CONFIG_DIR;
    process.env.LATTICE_CONFIG_DIR = configDir;
    ConversationService.resetInstance();
    DatabaseProvider.resetInstance();

    const sessionInfo = new SessionInfoService(':memory:');
    await sessionInfo.initialize();
    const conversations = ConversationService.getInstance();

    projectId = conversations.createConversation({
      provider: 'claude',
      providerSessionId: 'provider-project',
      workingDirectory: '/tmp/project',
      coordinator: true,
    }).conversationId;
    workerId = conversations.createConversation({
      provider: 'claude',
      providerSessionId: 'provider-worker',
      workingDirectory: '/tmp/project',
      pickedUpFrom: projectId,
    }).conversationId;

    await sessionInfo.updateSessionInfo(projectId, { archived: false });
    // The coordinator archives a worker when it is done with it.
    await sessionInfo.updateSessionInfo(workerId, { archived: true });

    const router = Router();
    registerUnifiedConversationQueryRoutes(router, {
      conversationService: conversations,
      sessionInfoService: sessionInfo,
      historyReader: {} as never,
      activeConversationRegistry: { get: () => undefined } as never,
      insightsEngine: {
        getCachedInsightsForSessions: async () => new Map(),
        backfillMissing: vi.fn(async () => {}),
      } as never,
      findRuntimeActiveSegment: () => null,
      getLatestSegmentForFallback: (conversation: { segments: Array<unknown> }) =>
        (conversation.segments[conversation.segments.length - 1] ?? null) as never,
    } as never);

    app = express();
    app.use('/api/conv', router);
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.LATTICE_CONFIG_DIR;
    else process.env.LATTICE_CONFIG_DIR = previousConfigDir;
    fs.rmSync(configDir, { recursive: true, force: true });
    ConversationService.resetInstance();
    DatabaseProvider.resetInstance();
  });

  it('is not in the list the sidebar loads', async () => {
    const response = await request(app).get('/api/conv?archived=false');
    expect(response.status).toBe(200);
    const ids = (response.body.conversations as Array<{ conversationId: string }>)
      .map(c => c.conversationId);
    expect(ids).toContain(projectId);
    expect(ids).not.toContain(workerId);
  });

  it('still reports its project on the details route', async () => {
    const response = await request(app).get(`/api/conv/${workerId}?limit=1`);
    expect(response.status).toBe(200);
    expect(response.body.pickedUpFrom).toBe(projectId);
  });
});

describe('resolveParentConversationId', () => {
  const PARENT = 'conv-project';

  it('reads the list row for a worker that is in the list', () => {
    expect(resolveParentConversationId({ pickedUpFrom: PARENT }, null)).toBe(PARENT);
  });

  it('falls back to the details route when there is no list row at all', () => {
    expect(resolveParentConversationId(undefined, { pickedUpFrom: PARENT })).toBe(PARENT);
  });

  it('is null for an ordinary session, from either source', () => {
    expect(resolveParentConversationId({}, {})).toBeNull();
    expect(resolveParentConversationId({ pickedUpFrom: null }, { pickedUpFrom: null })).toBeNull();
    expect(resolveParentConversationId(undefined, undefined)).toBeNull();
  });
});

describe('resolveIsCoordinator', () => {
  it('is true from either source, and from dispatched workers alone', () => {
    expect(resolveIsCoordinator({ coordinator: true }, null, 0)).toBe(true);
    expect(resolveIsCoordinator(undefined, { coordinator: true }, 0)).toBe(true);
    expect(resolveIsCoordinator({}, {}, 3)).toBe(true);
    expect(resolveIsCoordinator({}, {}, 0)).toBe(false);
  });

  it('holds for a nested coordinator: a worker that dispatches its own workers', () => {
    // It keeps its own workers panel, and it still knows its way back.
    const summary = { pickedUpFrom: 'conv-project', coordinator: true };
    expect(resolveIsCoordinator(summary, null, 0)).toBe(true);
    expect(resolveParentConversationId(summary, null)).toBe('conv-project');
  });
});

describe('resolveIsArchived', () => {
  it('takes the list row when there is one, including an explicit false', () => {
    expect(resolveIsArchived({ archived: false }, { sessionInfo: { archived: true } })).toBe(false);
    expect(resolveIsArchived({ archived: true }, { sessionInfo: { archived: false } })).toBe(true);
  });

  it('falls back to the details session info with no list row', () => {
    // Without this the header offers Archive on a session that is already
    // archived, and the click writes the state it is already in.
    expect(resolveIsArchived(undefined, { sessionInfo: { archived: true } })).toBe(true);
    expect(resolveIsArchived(null, { sessionInfo: { archived: false } })).toBe(false);
  });

  it('is false when neither source says anything', () => {
    expect(resolveIsArchived(undefined, undefined)).toBe(false);
    expect(resolveIsArchived({}, {})).toBe(false);
  });
});
