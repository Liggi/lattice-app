/**
 * GET /:conversationId/goal on a Codex conversation whose thread has not been
 * established yet must answer `{ goal: null }`, not 409. The client queries
 * the goal on every Codex conversation open; an idle conversation with a
 * pending thread used to answer 409 four times per open (React Query retries).
 * The 409 remains correct for the mutating goal routes.
 *
 * Drives the real route over a real HTTP server on an ephemeral port.
 */

import express from 'express';
import { EventEmitter } from 'events';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerUnifiedConversationControlRoutes } from '../../src/routes/conversation/unified-conversation.control-routes.js';

const CONV_ID = 'conv-CodexPending1';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const registry = Object.assign(new EventEmitter(), {
    get: () => undefined,
  });

  const conversationService = {
    getConversation: (id: string) =>
      id === CONV_ID
        ? { conversationId: CONV_ID, workingDirectory: '/tmp/x', workspace: '/tmp/x' }
        : null,
    getLatestSegment: () => ({ provider: 'codex', providerSessionId: `pending-${CONV_ID}` }),
  };

  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerUnifiedConversationControlRoutes(router, {
    activeConversationRegistry: registry as never,
    sessionInfoService: {} as never,
    historyReader: {} as never,
    insightsEngine: {} as never,
    resolveActiveStreamingId: () => null,
    resolveProviderSessionId: (id: string) => id,
    resolveTranscriptSessionId: (id: string) => id,
    conversationService: conversationService as never,
  });
  app.use('/api/conv', router);
  // Mirror the app's error handling shape: LatticeError -> statusCode + body.
  app.use((err: Error & { statusCode?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode ?? 500).json({ error: err.message, code: err.code });
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /:conversationId/goal with a pending Codex thread', () => {
  it('answers goal:null instead of 409', async () => {
    const res = await fetch(`${baseUrl}/api/conv/${CONV_ID}/goal`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ goal: null });
  });

  it('still 409s a goal write before the thread exists', async () => {
    const res = await fetch(`${baseUrl}/api/conv/${CONV_ID}/goal`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objective: 'ship it' }),
    });
    expect(res.status).toBe(409);
  });
});
