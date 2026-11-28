/**
 * Core `/api/jobs` routes: unified feed across local Lattice jobs and plugin
 * job providers, plus in-flow Stop for cancellable jobs.
 */

import { Router } from 'express';
import { asyncHandler } from '@/middleware/error-handler.js';
import { collectJobsFeed, stopUnifiedJob } from '@/services/sessions/job-registry.js';
import { ProgressError } from '@/services/sessions/job-progress.js';

export function createJobsRoutes(): Router {
  const router = Router();

  router.get('/', asyncHandler(async (_req, res) => {
    res.json(await collectJobsFeed());
  }));

  router.post('/:id/stop', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const body = (req.body ?? {}) as { why?: unknown };
    const why = typeof body.why === 'string' && body.why.trim() ? body.why.trim() : 'Stopped from Running now';
    try {
      res.json(await stopUnifiedJob(id, why));
    } catch (error) {
      if (error instanceof ProgressError) {
        res.status(400).json({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  }));

  return router;
}
