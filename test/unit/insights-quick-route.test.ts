import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => ({
  getInsightsQuick: vi.fn(async (sessionId: string) => ({ sessionId, context: null, tags: null, theme: null })),
  getInsights: vi.fn(async () => { throw new Error('generating path taken'); }),
}));
vi.mock('../../src/services/insights/insights-engine.js', () => ({
  InsightsEngine: { getInstance: () => engine },
}));
vi.mock('../../src/services/sessions/session-review-service.js', () => ({
  SessionReviewService: { getInstance: () => ({}) },
}));
vi.mock('../../src/services/sessions/turn-capture-service.js', () => ({
  TurnCaptureService: { getInstance: () => ({}) },
}));

const { queryParser } = await import('../../src/middleware/query-parser.js');
const { createInsightsRoutes } = await import('../../src/routes/insights/insights.routes.js');

describe('GET /api/insights/:sessionId/insights?quick=true', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  // queryParser turns "true" into a boolean, which a string comparison missed:
  // every quick read took the generating path and 503'd with generation off.
  it('reads the cache without generating, behind the app-wide query parser', async () => {
    const app = express();
    app.use(queryParser);
    app.use('/api/insights', createInsightsRoutes());
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/api/insights/conv-abc/insights?quick=true`);

    expect(response.status).toBe(200);
    expect(engine.getInsightsQuick).toHaveBeenCalledWith('conv-abc');
    expect(engine.getInsights).not.toHaveBeenCalled();
  });
});
