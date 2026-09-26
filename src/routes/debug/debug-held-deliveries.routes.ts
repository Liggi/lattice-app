/**
 * Held deliveries: the messages nobody can say arrived and nobody can say
 * did not.
 *
 * A message handed to a provider that never acknowledged it leaves rows that
 * are deliberately stuck — re-sending could repeat a correction the model has
 * already acted on, and marking them read would invent a receipt
 * (`session-inbox.ts`, `ReservationState`). Deciding between the two means
 * looking at the session's transcript, which no automatic path can do, so
 * these routes are the way a person looks and then says which it was.
 *
 *   GET  /api/debug/held-deliveries            everything held, newest first
 *   POST /api/debug/held-deliveries/:reservationId/resolve  { as: 'release' | 'delivered' }
 */

import { Router } from 'express';
import { createLogger } from '../../services/infrastructure/logger.js';
import {
  resolveUncertainReservation,
  uncertainInboxReservations,
} from '../../services/sessions/session-inbox.js';

const logger = createLogger('HeldDeliveries');

export function createDebugHeldDeliveryRoutes(): Router {
  const router = Router();

  router.get('/held-deliveries', (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    const rows = uncertainInboxReservations(sessionId);
    const byReservation = new Map<string, Array<(typeof rows)[number]>>();
    for (const row of rows) {
      if (!row.reserved_by) continue;
      const held = byReservation.get(row.reserved_by) ?? [];
      held.push(row);
      byReservation.set(row.reserved_by, held);
    }
    res.json({
      held: [...byReservation.entries()].map(([reservationId, items]) => ({
        reservationId,
        sessionId: items[0]?.session_id,
        heldSince: items[0]?.reserved_at,
        // Enough to find the exchange in the transcript and decide, without
        // having to open the database.
        items: items.map((row) => ({
          id: row.id,
          source: row.source,
          createdAt: row.created_at,
          text: row.text,
        })),
      })),
    });
  });

  router.post('/held-deliveries/:reservationId/resolve', (req, res) => {
    const { reservationId } = req.params;
    const as = (req.body as { as?: unknown })?.as;
    if (as !== 'release' && as !== 'delivered') {
      res.status(400).json({
        error: 'bad_request',
        message: 'as must be "release" (the message never reached the model) or "delivered" (it did)',
      });
      return;
    }
    const items = resolveUncertainReservation(reservationId, as);
    if (items === 0) {
      res.status(404).json({ error: 'not_found', message: 'No held delivery with that reservation id' });
      return;
    }
    logger.info('A held delivery was settled by hand', { reservationId, as, items });
    res.json({ ok: true, reservationId, as, items });
  });

  return router;
}
