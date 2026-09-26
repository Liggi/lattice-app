/**
 * Live `activity` events on the unified stream must carry conv-* IDs.
 *
 * SessionActivityWatcher derives its sessionId from the JSONL filename, i.e.
 * the provider session UUID. Clients key their recentActions map on conv-*, so
 * an unresolved UUID matches nothing they hold and the sidebar's mini action
 * log silently never updates from the live stream. Every sibling handler on
 * this route resolves before writing; this one did not.
 *
 * Drives the real route over a real HTTP server on an ephemeral port. Nothing
 * here touches port 3001.
 */

import express from 'express';
import { EventEmitter } from 'events';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerUnifiedConversationTransportRoutes } from '../../src/routes/conversation/unified-conversation.transport-routes.js';
import { getSessionActivityWatcher } from '../../src/services/sessions/session-activity-watcher.js';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { runSessionInfoSchemaBootstrap } from '../../src/services/sessions/session-info-migrations.js';
import { createLogger } from '../../src/services/infrastructure/logger.js';

const PROVIDER_SESSION_ID = '4451d2eb-5323-4db1-ad90-b80dde943f9a';
const MAPPED_CONVERSATION_ID = 'conv-Mapped123';
const UNMAPPED_SESSION_ID = 'a0000000-0000-4000-8000-000000000000';

let server: Server;
let baseUrl: string;
let configDir: string;

beforeAll(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-activity-stream-'));
  process.env.LATTICE_CONFIG_DIR = configDir;

  // The watcher singleton builds an InsightsEngine, which prepares statements
  // against the session DB. Give it a migrated in-memory one — nothing here
  // should reach the real ~/.lattice store.
  DatabaseProvider.resetInstance();
  runSessionInfoSchemaBootstrap(
    DatabaseProvider.getInstance(':memory:').getDb(),
    createLogger('ActivityStreamSessionIdTest'),
  );

  const registry = Object.assign(new EventEmitter(), {
    getByProviderSessionId: (id: string) =>
      (id === PROVIDER_SESSION_ID ? { conversationId: MAPPED_CONVERSATION_ID } : undefined),
    getActiveProviderSessionIds: () => [],
    getAll: () => [],
  });

  const app = express();
  const router = express.Router();
  registerUnifiedConversationTransportRoutes(router, {
    activeConversationRegistry: registry as never,
    conversationService: { listConversations: () => ({ conversations: [] }) } as never,
    sessionInfoService: { getSessionInfoSync: () => null } as never,
    historyReader: {} as never,
    insightsEngine: {
      extractRecentActions: () => [],
      getCachedInsightsForSessions: async () => new Map(),
    } as never,
    conversationIdResolutionService: {} as never,
    permissionTracker: new EventEmitter() as never,
  });
  app.use('/api/conv', router);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  getSessionActivityWatcher().stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(configDir, { recursive: true, force: true });
  delete process.env.LATTICE_CONFIG_DIR;
});

/**
 * Opens the stream, waits for the server to finish its connect sequence, runs
 * `act`, then returns every frame seen within a short settle window.
 */
async function collectFrames(act: () => void): Promise<Array<Record<string, unknown>>> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/conv/activity-stream`, { signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Array<Record<string, unknown>> = [];
  let buffer = '';
  let acted = false;

  const drain = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const payload = part.replace(/^data: /, '').trim();
        if (!payload) continue;
        frames.push(JSON.parse(payload) as Record<string, unknown>);
      }
      // The watcher handlers are attached in the same tick as the `connected`
      // frame's dynamic import resolves, so acting on it is safe.
      if (!acted && frames.some((f) => f.type === 'connected')) {
        acted = true;
        act();
      }
    }
  })();

  await new Promise((resolve) => setTimeout(resolve, 400));
  controller.abort();
  await drain.catch(() => undefined);
  return frames;
}

describe('GET /api/conv/activity-stream — live activity events', () => {
  it('resolves the watcher\'s provider session UUID to the conversation ID', async () => {
    const frames = await collectFrames(() => {
      getSessionActivityWatcher().emit('activity', {
        sessionId: PROVIDER_SESSION_ID,
        recentActions: [{ tool: 'Bash', timestamp: 1 }],
        timestamp: 1,
      });
    });

    const activity = frames.filter((f) => f.type === 'activity');
    expect(activity).toHaveLength(1);
    expect(activity[0].sessionId).toBe(MAPPED_CONVERSATION_ID);
    expect(activity[0].recentActions).toEqual([{ tool: 'Bash', timestamp: 1 }]);
  });

  it('passes a conv-* id straight through', async () => {
    const frames = await collectFrames(() => {
      getSessionActivityWatcher().emit('activity', {
        sessionId: 'conv-AlreadyUnified',
        recentActions: [{ tool: 'Read', timestamp: 2 }],
        timestamp: 2,
      });
    });

    const activity = frames.filter((f) => f.type === 'activity');
    expect(activity).toHaveLength(1);
    expect(activity[0].sessionId).toBe('conv-AlreadyUnified');
  });

  it('drops an activity event it cannot attribute to a conversation', async () => {
    const frames = await collectFrames(() => {
      getSessionActivityWatcher().emit('activity', {
        sessionId: UNMAPPED_SESSION_ID,
        recentActions: [{ tool: 'Bash', timestamp: 3 }],
        timestamp: 3,
      });
    });

    // A raw UUID would match no client entry; a null id carries nothing the
    // client's handler can index. Neither is worth writing.
    expect(frames.filter((f) => f.type === 'activity')).toEqual([]);
    expect(frames.some((f) => f.type === 'connected')).toBe(true);
  });
});
