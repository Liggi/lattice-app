/**
 * Debug Routes - assistant-first observability surfaces.
 *
 * Split by domain:
 * - message storage/lifecycle
 * - conversation forensics/repair
 * - session state diagnostics
 */

import { Router } from 'express';
import type { ActiveConversationRegistry } from '../../services/process/active-conversation-registry.js';
import { createDebugRouteContext, type DebugRouteOptions } from './debug-route-utils.js';
import { createDebugConversationRoutes } from './debug-conversation.routes.js';
import { createDebugSessionRoutes } from './debug-session.routes.js';
import { createDebugHarnessSnapshotRoutes } from './debug-harness-snapshot.routes.js';
import { createDebugHydrationTraceRoutes } from './debug-hydration-trace.routes.js';
import { createDebugHeldDeliveryRoutes } from './debug-held-deliveries.routes.js';
import { createDebugWorkerLifecycleRoutes } from './debug-worker-lifecycle.routes.js';

export function createDebugRoutes(
  activeConversationRegistry?: ActiveConversationRegistry,
  options: DebugRouteOptions = {},
): Router {
  const router = Router();
  const context = createDebugRouteContext(activeConversationRegistry, options);

  router.use(createDebugConversationRoutes(context));
  router.use(createDebugSessionRoutes(context));
  router.use(createDebugHarnessSnapshotRoutes(context));
  router.use(createDebugHydrationTraceRoutes());
  router.use(createDebugHeldDeliveryRoutes());
  router.use(createDebugWorkerLifecycleRoutes());

  if (activeConversationRegistry) {
    router.get('/conversations/:id/runtime', (req, res) => {
      const record = activeConversationRegistry.toJSON(req.params.id);
      if (!record) {
        res.status(404).json({ error: 'not_found', message: 'No active conversation with this ID' });
        return;
      }
      res.json(record);
    });
    router.get('/registry', (_req, res) => {
      res.json({
        activeCount: activeConversationRegistry.size,
        conversations: activeConversationRegistry.toDebugSummary(),
      });
    });
  }

  return router;
}
