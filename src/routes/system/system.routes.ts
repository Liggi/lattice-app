import { Router, Request, Response } from 'express';
import { SystemStatusResponse, LatticeError, CommandsResponse } from '@/types/index.js';
import { RequestWithRequestId } from '@/types/express.js';
import { createLogger, type Logger } from '@/services/infrastructure/logger.js';
import { getEventJournal } from '@/services/infrastructure/event-journal.js';
import { getAvailableCommands } from '@/services/commands-service.js';
import { execSync } from 'child_process';
import { anthropicService } from '@/services/insights/anthropic-service.js';
import { asyncHandler } from '@/middleware/error-handler.js';


interface ClientTelemetryBody {
  component?: string;
  event?: string;
  severity?: 'info' | 'warn' | 'error';
  traceId?: string;
  details?: Record<string, unknown>;
}

export function truncateTelemetryValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated-depth]';

  if (typeof value === 'string') {
    return value.length > 300 ? `${value.slice(0, 297)}...` : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    const capped = value.slice(0, 20).map((item) => truncateTelemetryValue(item, depth + 1));
    if (value.length > 20) capped.push('[truncated-array]');
    return capped;
  }

  if (typeof value === 'object' && value) {
    const entries = Object.entries(value).slice(0, 30);
    const truncatedEntries = entries.map(([key, item]) => [key, truncateTelemetryValue(item, depth + 1)]);
    return Object.fromEntries(truncatedEntries);
  }

  return String(value);
}

// Deduplicate client.telemetry_error journal entries by component:event key.
// Repeated errors from the same source within this window are logged but not journaled.
const TELEMETRY_ERROR_JOURNAL_DEDUPE_MS = 10_000;
const telemetryErrorDedupeMap = new Map<string, number>();

export function createSystemRoutes(): Router {
  const router = Router();
  const logger = createLogger('SystemRoutes');

  // Health check
  router.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Check Anthropic API credit status (lightweight — only calls API if credits were flagged exhausted)
  router.post('/check-credits', asyncHandler(async (req: RequestWithRequestId, res) => {
    const logger2 = createLogger('SystemRoutes');
    logger2.info('Credit check requested');

    if (!anthropicService.creditsExhausted) {
      res.json({ creditsExhausted: false });
      return;
    }

    // Credits were exhausted — try a health check to see if they're back
    const health = await anthropicService.checkHealth();
    // checkHealth uses withRetry, which calls markCreditsAvailable() on success
    res.json({
      creditsExhausted: anthropicService.creditsExhausted,
      healthStatus: health.status,
    });
  }));

  // Get system status
  router.get('/status', asyncHandler(async (req: RequestWithRequestId, res) => {
    const requestId = req.requestId;
    logger.debug('Get system status request', { requestId });

    const systemStatus = await getSystemStatus(logger);

    logger.debug('System status retrieved', {
      requestId,
      ...systemStatus
    });

    res.json(systemStatus);
  }));


  // Get available commands
  router.get('/commands', asyncHandler(async (req: RequestWithRequestId, res) => {
    const requestId = req.requestId;
    const workingDirectory = req.query.workingDirectory as string | undefined;

    logger.debug('Get commands request', { requestId, workingDirectory });

    const commands = getAvailableCommands(workingDirectory);

    const response: CommandsResponse = {
      commands
    };

    logger.debug('Commands retrieved', {
      requestId,
      commandCount: commands.length,
      workingDirectory
    });

    res.json(response);
  }));


  // Lightweight client telemetry endpoint for proactive UX/regression detection
  router.post('/telemetry/client', (req: Request, res: Response) => {
    const body = req.body as ClientTelemetryBody;
    const component = body.component?.trim();
    const event = body.event?.trim();
    const severity = body.severity || 'info';

    if (!component || !event) {
      res.status(400).json({ error: 'component and event required' });
      return;
    }

    const payload = {
      component,
      event,
      severity,
      traceId: body.traceId || null,
      details: truncateTelemetryValue(body.details || {}),
    };

    const isSlowEvent = event.endsWith('-slow') || event.includes('fallback');

    if (severity === 'error') {
      logger.error('[CLIENT-TELEMETRY]', payload);
      const dedupeKey = `${component}:${event}`;
      const now = Date.now();
      const lastSeen = telemetryErrorDedupeMap.get(dedupeKey) ?? 0;
      if (now - lastSeen >= TELEMETRY_ERROR_JOURNAL_DEDUPE_MS) {
        telemetryErrorDedupeMap.set(dedupeKey, now);
        getEventJournal().record({
          event: 'client.telemetry_error',
          severity: 'error',
          component,
          traceId: body.traceId || undefined,
          fields: payload,
        });
      }
    } else if (severity === 'warn' && !isSlowEvent) {
      logger.warn('[CLIENT-TELEMETRY]', payload);
    } else {
      logger.debug('[CLIENT-TELEMETRY]', payload);
    }

    res.json({ logged: true });
  });

  return router;
}

/**
 * Get system status including Claude version
 */
async function getSystemStatus(
  logger: Logger
): Promise<SystemStatusResponse> {
  try {
    let claudeVersion = 'unknown';
    let claudePath = 'unknown';

    try {
      claudePath = execSync('which claude', { encoding: 'utf-8' }).trim();
      claudeVersion = execSync('claude --version', { encoding: 'utf-8' }).trim();
      logger.debug('Claude version info retrieved', {
        version: claudeVersion,
        path: claudePath
      });
    } catch (error) {
      logger.warn('Failed to get Claude version information', {
        error: error instanceof Error ? error.message : String(error),
        errorCode: error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined
      });
    }

    return {
      claudeVersion,
      claudePath,
      configPath: '',
      activeConversations: 0,
      anthropicConfigured: anthropicService.isConfigured()
    };
  } catch (_error) {
    throw new LatticeError('SYSTEM_STATUS_ERROR', 'Failed to get system status', 500);
  }
}
