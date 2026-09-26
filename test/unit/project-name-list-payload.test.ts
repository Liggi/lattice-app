/**
 * GET /api/conv is what the sidebar renders from, so a project's generated
 * name has to arrive in that payload beside the name the user typed rather
 * than merged into it. Drives the real route, like the batching tests next
 * door, because the response shape is the contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { Router } from 'express';
import request from 'supertest';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';
import { registerUnifiedConversationQueryRoutes } from '../../src/routes/conversation/unified-conversation.query-routes.js';
import type { UnifiedConversationQueryRoutesContext } from '../../src/routes/conversation/unified-conversation.query-routes.js';

interface ListedConversation {
  conversationId: string;
  customName: string;
  projectName: string | null;
}

describe('GET /api/conv project names', () => {
  let sessionInfo: SessionInfoService;
  let app: express.Express;
  let projectId: string;
  let sessionId: string;

  beforeEach(async () => {
    ConversationService.resetInstance();
    DatabaseProvider.resetInstance();

    sessionInfo = new SessionInfoService(':memory:');
    await sessionInfo.initialize();
    const conversations = ConversationService.getInstance();

    const project = conversations.createConversation({
      provider: 'claude',
      providerSessionId: 'provider-project',
      workingDirectory: '/tmp/project',
    });
    const session = conversations.createConversation({
      provider: 'claude',
      providerSessionId: 'provider-session',
      workingDirectory: '/tmp/session',
    });
    projectId = project.conversationId;
    sessionId = session.conversationId;

    await sessionInfo.updateSessionInfo(projectId, {
      archived: false,
      project_name: 'Lattice orchestrator and restyled app',
    });
    await sessionInfo.updateSessionInfo(sessionId, { archived: false });

    const router = Router();
    const context = {
      conversationService: conversations,
      sessionInfoService: sessionInfo,
      historyReader: {} as never,
      activeConversationRegistry: {} as never,
      insightsEngine: {
        getCachedInsightsForSessions: async () => new Map(),
        backfillMissing: vi.fn(async () => {}),
      } as never,
      findRuntimeActiveSegment: () => null,
      getLatestSegmentForFallback: (conversation: { segments: Array<unknown> }) =>
        (conversation.segments[conversation.segments.length - 1] ?? null) as never,
    } as unknown as UnifiedConversationQueryRoutesContext;

    registerUnifiedConversationQueryRoutes(router, context);
    app = express();
    app.use('/api/conv', router);
  });

  afterEach(() => {
    ConversationService.resetInstance();
    DatabaseProvider.resetInstance();
  });

  async function list(): Promise<Map<string, ListedConversation>> {
    const response = await request(app).get('/api/conv').expect(200);
    return new Map(
      (response.body.conversations as ListedConversation[]).map(row => [row.conversationId, row]),
    );
  }

  it('serves a project name beside the custom name, not folded into it', async () => {
    const rows = await list();
    expect(rows.get(projectId)?.projectName).toBe('Lattice orchestrator and restyled app');
    expect(rows.get(projectId)?.customName).toBe('');
  });

  it('serves null for a session that has no project name', async () => {
    const rows = await list();
    expect(rows.get(sessionId)?.projectName).toBeNull();
  });

  it('keeps both when the user renames a project that already has a generated name', async () => {
    await sessionInfo.updateSessionInfo(projectId, { custom_name: 'Lattice' });

    const rows = await list();
    expect(rows.get(projectId)?.customName).toBe('Lattice');
    // Still served, so clearing the custom name later falls back to it rather
    // than dropping to the drifting mission.
    expect(rows.get(projectId)?.projectName).toBe('Lattice orchestrator and restyled app');
  });

  it('survives a reload: the name is on the row, not in memory', async () => {
    // A second service over the same file, which is what a restart is. An
    // in-memory database cannot show this, so this case builds its own.
    const dir = mkdtempSync(join(tmpdir(), 'project-name-list-'));
    try {
      const dbPath = join(dir, 'session-info.db');
      DatabaseProvider.resetInstance();
      const first = new SessionInfoService(dbPath);
      await first.initialize();
      await first.updateSessionInfo(projectId, { archived: false, project_name: 'Canary reports for release decisions' });

      DatabaseProvider.resetInstance();
      const second = new SessionInfoService(dbPath);
      await second.initialize();

      expect((await second.getSessionInfo(projectId)).project_name).toBe('Canary reports for release decisions');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
