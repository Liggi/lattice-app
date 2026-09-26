import { Router } from 'express';
import { homedir } from 'os';
import { join } from 'path';
import { asyncHandler } from '@/middleware/error-handler.js';

export const AMBIENT_LATEST_PATH = join(homedir(), '.lattice', 'ambient', 'latest.json');
const PING_URL = 'http://127.0.0.1:43117/refresh';
const DISPATCH_LOG_URL = 'http://127.0.0.1:43117/dispatch-log';

export interface AmbientRouteDependencies {
  fetchUpstream?: typeof fetch;
}

export function createAmbientRoutes(dependencies: AmbientRouteDependencies = {}): Router {
  const router = Router();
  const fetchUpstream = dependencies.fetchUpstream ?? fetch;

  router.get('/ambient/latest.json', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(AMBIENT_LATEST_PATH, (error) => {
      if (error && !res.headersSent) {
        res.status(404).json({ error: 'ambient scan not available yet' });
      }
    });
  });

  router.post('/ambient-watch/refresh', asyncHandler(async (_req, res) => {
    try {
      const upstream = await fetchUpstream(PING_URL, { method: 'POST' });
      if (!upstream.ok) {
        res.status(upstream.status).json({ error: 'ambient scan refresh failed' });
        return;
      }
    } catch {
      res.status(502).json({ error: 'ambient watcher is not reachable' });
      return;
    }
    res.status(204).end();
  }));

  // The dispatch log lives in the ambient watcher process; forward to it so the
  // served UI can log draft sends without the server owning ambient state.
  router.post('/ambient-watch/dispatch-log', asyncHandler(async (req, res) => {
    try {
      const upstream = await fetchUpstream(DISPATCH_LOG_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body ?? {}),
      });
      res.status(upstream.status).end();
    } catch {
      res.status(502).json({ error: 'ambient watcher is not reachable' });
    }
  }));

  return router;
}
