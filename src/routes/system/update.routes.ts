import { Router } from 'express';
import { asyncHandler } from '@/middleware/error-handler.js';
import { getUpdateService } from '@/services/updates/update-service.js';

export function createUpdateRoutes(): Router {
  const router = Router();
  const updates = getUpdateService();

  router.get('/', (_req, res) => {
    res.json(updates.status());
  });

  router.get('/notes', asyncHandler(async (_req, res) => {
    res.json({ notes: await updates.releaseNotes() });
  }));

  router.post('/', (_req, res) => {
    const started = updates.startUpdate();
    if (!started.ok) {
      res.status(409).json({ error: started.message });
      return;
    }
    res.status(202).json(updates.status());
  });

  return router;
}
