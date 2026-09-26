/**
 * Worker lifecycle checks, run by hand.
 *
 *   GET  /api/debug/workers/finished                  what the auto-archive rule would archive now, every project
 *   POST /api/debug/workers/finished/archive          archive them (the one-off pass over workers that finished
 *                                                     before the rule existed; afterwards notes trigger it)
 *   GET  /api/debug/workers/unarmed-waits             waiting workers nothing will wake, every recently active project
 *
 * See services/sessions/worker-auto-archive.ts and wait-watch.ts.
 */

import { Router } from 'express';
import { DatabaseProvider } from '../../services/infrastructure/database-provider.js';
import { archiveFinishedWorkersEverywhere } from '../../services/sessions/worker-auto-archive.js';
import { unarmedWaitReason } from '../../services/sessions/wait-watch.js';
import { readWorkerStates } from '../../services/sessions/worker-events.js';

export function createDebugWorkerLifecycleRoutes(): Router {
  const router = Router();

  router.get('/workers/finished', (_req, res) => {
    res.json({ projects: archiveFinishedWorkersEverywhere({ dryRun: true }) });
  });

  router.post('/workers/finished/archive', (_req, res) => {
    res.json({ projects: archiveFinishedWorkersEverywhere() });
  });

  router.get('/workers/unarmed-waits', (_req, res) => {
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const coordinators = DatabaseProvider.getInstance().getDb().prepare(
      `SELECT DISTINCT c.conversation_id AS id FROM conversations c
         JOIN harness_events e ON e.session_id = c.conversation_id
        WHERE c.coordinator = 1 AND e.type = 'worker:reported' AND e.timestamp >= ?`,
    ).all(since) as Array<{ id: string }>;
    const found = coordinators.flatMap(({ id }) => {
      const states = readWorkerStates(id);
      const roster = states.map((state) => state.worker);
      const archived = new Set((DatabaseProvider.getInstance().getDb().prepare(
        `SELECT session_id AS id FROM sessions WHERE archived = 1 AND session_id IN (${roster.map(() => '?').join(',') || "''"})`,
      ).all(...roster) as Array<{ id: string }>).map((row) => row.id));
      return states
        .filter((state) => !archived.has(state.worker))
        .map((state) => ({ coordinator: id, worker: state.worker, waitingOn: state.waitingOn, reason: unarmedWaitReason(id, state, roster) }))
        .filter((entry) => entry.reason !== null);
    });
    res.json({ unarmed: found });
  });

  return router;
}
