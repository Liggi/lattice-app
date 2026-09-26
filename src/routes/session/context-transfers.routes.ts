import type { Provider } from '@/types/unified-messages.js';
/**
 * Context Transfers Routes
 *
 * API endpoints for viewing cross-provider context transfer records.
 * Endpoints for viewing cross-provider context transfer history (debugging).
 */

import { Router, Request, Response } from 'express';
import { SessionInfoService } from '../../services/sessions/session-info-service.js';

export function createContextTransfersRoutes(): Router {
  const router = Router();
  const sessionInfoService = SessionInfoService.getInstance();

  /**
   * GET /api/context-transfers/:conversationId/last
   * Get the most recent context transfer to a provider.
   * Query params: toProvider (Provider)
   */
  router.get('/:conversationId/last', (req: Request, res: Response) => {
    const { conversationId } = req.params;
    const { toProvider } = req.query;

    if (!toProvider || (toProvider !== 'claude' && toProvider !== 'codex')) {
      res.status(400).json({ error: 'toProvider query param required (claude or codex)' });
      return;
    }

    const result = sessionInfoService.getLastContextTransfer(
      conversationId,
      toProvider as Provider
    );

    res.json(result);
  });

  return router;
}
