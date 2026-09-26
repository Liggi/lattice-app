/**
 * API routes for SessionTimeline observability.
 *
 * Provides endpoints to query per-conversation lifecycle timelines,
 * latency gaps, and to ingest client-side milestones.
 */

import { Router, type Request, type Response } from 'express';
import { getSessionTimeline } from '../../services/process/session-timeline.js';
import { parsePositiveIntQuery } from '@/utils/query-helpers.js';

const router: Router = Router();

/**
 * GET /api/timeline/active
 * Get conversations with recent timeline milestones.
 */
router.get('/active', (_req: Request, res: Response) => {
  const timeline = getSessionTimeline();
  const conversations = timeline.getActiveConversations();
  res.json({ conversations, pendingCount: timeline.getPendingCount() });
});

/**
 * GET /api/timeline/:conversationId
 * Get the full milestone timeline for a conversation.
 *
 * Query params:
 *   limit: max milestones (default 100)
 *   format: 'json' | 'formatted' (default 'json')
 */
router.get('/:conversationId', (req: Request, res: Response) => {
  const { conversationId } = req.params;
  const limit = parsePositiveIntQuery(req.query.limit, { defaultValue: 100 }) ?? 100;
  const format = req.query.format === 'formatted' ? 'formatted' : 'json';

  const timeline = getSessionTimeline();

  if (format === 'formatted') {
    const lines = timeline.getFormattedTimeline(conversationId, limit);
    res.type('text/plain').send(lines.join('\n'));
    return;
  }

  const milestones = timeline.getTimeline(conversationId, limit);
  const gaps = timeline.getGaps(conversationId);
  const slowest = gaps.length > 0
    ? gaps.reduce((a, b) => a.durationMs > b.durationMs ? a : b)
    : null;

  res.json({ milestones, gaps, slowest });
});

/**
 * GET /api/timeline/:conversationId/gaps
 * Get just the latency gaps between milestones.
 */
router.get('/:conversationId/gaps', (req: Request, res: Response) => {
  const { conversationId } = req.params;
  const timeline = getSessionTimeline();
  const gaps = timeline.getGaps(conversationId);
  const slowest = gaps.length > 0
    ? gaps.reduce((a, b) => a.durationMs > b.durationMs ? a : b)
    : null;

  res.json({ gaps, slowest });
});

/**
 * POST /api/timeline/milestone
 * Ingest a client-side milestone.
 *
 * Body:
 *   conversationId: string
 *   milestone: string
 *   clientTimestamp?: number (Date.now() from the browser)
 *   streamingId?: string
 *   fields?: Record<string, unknown>
 */
router.post('/milestone', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId : undefined;
  const milestone = typeof body.milestone === 'string' ? body.milestone : undefined;
  const clientTimestamp = typeof body.clientTimestamp === 'number' ? body.clientTimestamp : undefined;
  const streamingId = typeof body.streamingId === 'string' ? body.streamingId : undefined;
  const fields = body.fields != null && typeof body.fields === 'object' ? (body.fields as Record<string, unknown>) : undefined;

  if (!milestone) {
    res.status(400).json({ error: 'milestone is required' });
    return;
  }

  const timeline = getSessionTimeline();

  if (conversationId) {
    timeline.mark(conversationId, milestone, {
      streamingId,
      source: 'client',
      fields,
      timestamp: clientTimestamp,
    });
  } else if (streamingId) {
    timeline.markByStreamingId(streamingId, milestone, {
      source: 'client',
      fields,
      timestamp: clientTimestamp,
    });
  } else {
    res.status(400).json({ error: 'conversationId or streamingId is required' });
    return;
  }

  res.json({ ok: true });
});

export default router;
