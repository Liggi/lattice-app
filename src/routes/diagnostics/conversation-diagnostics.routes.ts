/**
 * GET /api/diagnostics/conversations/:conversationId
 *
 * Single per-conversation diagnostics endpoint (§1.1, §4).
 *
 * Read-only. Default-redacted. Access-controlled via §1.2.
 */

import { Router } from 'express';
import { asyncHandler } from '@/middleware/error-handler.js';
import { createLogger } from '@/services/infrastructure/logger.js';
import {
  collectConversationDiagnostics,
  type DiagnosticsRuntimeDeps,
} from '@/diagnostics/collect-conversation-diagnostics.js';
import {
  describeAccessMode,
  mayReadDiagnostics,
  mayReadRawDiagnostics,
} from '@/diagnostics/access-control.js';

const logger = createLogger('ConversationDiagnosticsRoutes');

function asBool(value: unknown): boolean {
  return value === true || value === 'true' || value === '1';
}

function asPositiveInt(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

export function createConversationDiagnosticsRoutes(
  runtime?: DiagnosticsRuntimeDeps,
): Router {
  const router = Router();

  router.get(
    '/conversations/:conversationId',
    asyncHandler(async (req, res) => {
      const { conversationId } = req.params as { conversationId: string };

      if (!mayReadDiagnostics(req)) {
        res.status(403).json({
          error: 'diagnostics_disabled',
          message:
            'Runtime diagnostics are disabled. Set LATTICE_DIAGNOSTICS_ENABLED=true and authenticate as admin, or call from loopback in development.',
        });
        return;
      }

      const rawAllowed = mayReadRawDiagnostics(req);
      const access = {
        mode: describeAccessMode(req),
        redaction: rawAllowed && (asBool(req.query.includeRawEvents) || asBool(req.query.includeRawSources))
          ? ('raw' as const)
          : ('redacted' as const),
        rawAllowed,
      };

      const report = await collectConversationDiagnostics({
        conversationId,
        eventLimit: asPositiveInt(req.query.eventLimit),
        includeRawEvents: asBool(req.query.includeRawEvents),
        includeProcessDetails: asBool(req.query.includeProcessDetails),
        includeRawSources: asBool(req.query.includeRawSources),
        access,
        requestId: req.requestId,
        runtime,
      });

      logger.info('diagnostics.conversation.read', {
        conversationId,
        requestId: report.request.requestId,
        rawIncluded: report.request.includeRawEvents,
        processDetailsIncluded: report.request.includeProcessDetails,
      });

      res.json(report);
    }),
  );

  return router;
}
