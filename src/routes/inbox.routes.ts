/**
 * `GET /api/inbox`: the cross-project Inbox (`types/inbox-feed.ts`). Reads
 * only local state, so it answers without waiting on git or GitHub.
 * `POST /api/inbox/dismiss` & `POST /api/inbox/restore`: dismiss or restore
 * alert items (`failing-pr`, `failed-run`, `stalled-job`) until their state
 * changes.
 */

import { Router } from 'express';
import { asyncHandler } from '@/middleware/error-handler.js';
import { buildInboxFeed } from '@/services/sessions/inbox-feed.js';
import { readInboxSources } from '@/services/sessions/inbox-feed-sources.js';
import { alertSignature, inboxDismissals } from '@/services/sessions/inbox-dismissals.js';

export function createInboxRoutes(): Router {
  const router = Router();
  router.get('/', asyncHandler(async (_req, res) => {
    res.json(buildInboxFeed(await readInboxSources()));
  }));

  router.post('/dismiss', asyncHandler(async (req, res) => {
    const id = typeof (req.body as { id?: unknown } | undefined)?.id === 'string'
      ? (req.body as { id: string }).id.trim()
      : '';
    if (!id) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    const sources = await readInboxSources();
    const feed = buildInboxFeed({ ...sources, isDismissed: undefined });
    const item = feed.items.find((candidate) => candidate.id === id);
    const sig = item ? alertSignature(item) : null;
    if (sig) inboxDismissals().dismiss(id, sig);
    res.json({ ok: true, dismissed: Boolean(sig) });
  }));

  router.post('/restore', asyncHandler(async (req, res) => {
    const id = typeof (req.body as { id?: unknown } | undefined)?.id === 'string'
      ? (req.body as { id: string }).id.trim()
      : '';
    if (!id) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    const restored = inboxDismissals().restore(id);
    res.json({ ok: true, restored });
  }));

  return router;
}
