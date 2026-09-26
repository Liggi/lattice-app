import { Router, Request } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { logStreamBuffer } from '@/services/infrastructure/log-stream-buffer.js';
import { createLogger } from '@/services/infrastructure/logger.js';
import { getEventJournal } from '@/services/infrastructure/event-journal.js';
import { RequestWithRequestId } from '@/types/express.js';
import { getBrowserIncidentLog } from '@/services/browser-incident-log.js';
import { getPermissionEventLog } from '@/services/permission-event-log.js';
import { asyncHandler } from '@/middleware/error-handler.js';
import { parsePositiveIntQuery } from '@/utils/query-helpers.js';
import { parseJson } from '../../utils/json.js';
import {
  BROWSER_CONSOLE_LOG_PATH,
  BROWSER_INCIDENTS_LOG_PATH,
  CONNECTION_DEBUG_LOG_PATH,
  DAEMON_JSONL_LOG_PATH,
  EVENT_JOURNAL_PATH,
  PERMISSION_LOG_PATH,
  SERVER_JSONL_LOG_PATH,
  appendJsonlRecord,
} from '@/services/infrastructure/structured-log-files.js';

// Debug log file for browser + server logs
const DEBUG_LOG_PATH = path.join(os.homedir(), 'lattice-debug.log');

// Max debug log size before rotation (50MB)
const MAX_DEBUG_LOG_SIZE = 50 * 1024 * 1024;

// Watchdog for the `tail` child processes below.
const TAIL_TIMEOUT_MS = 5000;

/**
 * Each open /logs/stream client adds one 'log' listener to the process-wide
 * buffer. The default cap of 10 warns spuriously once a few tabs are open;
 * PermissionTracker sets the same ceiling for the same reason.
 */
const LOG_STREAM_MAX_LISTENERS = 100;

interface StructuredRecord extends Record<string, unknown> {
  ts?: string;
  time?: string;
  timestampIso?: string;
  timestamp?: number | string;
  level?: string;
  severity?: string;
  traceId?: string;
  requestId?: string;
  conversationId?: string;
  sessionId?: string;
  streamingId?: string;
  fields?: Record<string, unknown>;
}

interface ExportFilters {
  conversationId?: string;
  sessionId?: string;
  streamingId?: string;
  traceId?: string;
}

/**
 * Check debug log size and rotate if needed
 */
function rotateDebugLogIfNeeded(): void {
  try {
    if (!fs.existsSync(DEBUG_LOG_PATH)) return;

    const stats = fs.statSync(DEBUG_LOG_PATH);
    if (stats.size > MAX_DEBUG_LOG_SIZE) {
      // Rotate: rename current to .old, start fresh
      const oldPath = DEBUG_LOG_PATH + '.old';
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
      fs.renameSync(DEBUG_LOG_PATH, oldPath);
      fs.writeFileSync(DEBUG_LOG_PATH, `--- Debug log rotated at ${new Date().toISOString()} (previous log saved as .old) ---\n`);
    }
  } catch {
    // Ignore rotation errors - don't break logging
  }
}

function parseRecordTimestamp(record: StructuredRecord): number | null {
  const raw = record.ts ?? record.time ?? record.timestampIso ?? record.timestamp;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function matchesStructuredFilters(record: StructuredRecord, cutoffTime: number, filters: ExportFilters): boolean {
  const recordTime = parseRecordTimestamp(record);
  if (recordTime !== null && recordTime < cutoffTime) {
    return false;
  }

  const fields = record.fields && typeof record.fields === 'object'
    ? record.fields as Record<string, unknown>
    : {};

  const matches = (key: keyof ExportFilters): boolean => {
    const filterValue = filters[key];
    if (!filterValue) return true;
    const candidate = record[key] ?? fields[key];
    return candidate === filterValue;
  };

  return matches('conversationId')
    && matches('sessionId')
    && matches('streamingId')
    && matches('traceId');
}

function tailLines(filePath: string, lines: number): Promise<string[]> {
  return new Promise((resolve) => {
    if (!fs.existsSync(filePath)) {
      resolve([]);
      return;
    }

    const tail = spawn('tail', ['-n', String(lines), filePath]);
    let output = '';

    // The watchdog outlives the child unless it is cancelled: `tail` normally
    // exits in milliseconds, so an uncleared handle held the closure (and the
    // accumulated output buffer) for a further 5s on every log request.
    const watchdog = setTimeout(() => {
      tail.kill();
      resolve([]);
    }, TAIL_TIMEOUT_MS);

    tail.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });

    tail.on('close', () => {
      clearTimeout(watchdog);
      resolve(output.split('\n').filter(line => line.trim().length > 0));
    });

    tail.on('error', () => {
      clearTimeout(watchdog);
      resolve([]);
    });
  });
}

async function tailStructuredRecords(
  filePath: string,
  lines: number,
  cutoffTime: number,
  filters: ExportFilters
): Promise<StructuredRecord[]> {
  const tailedLines = await tailLines(filePath, lines);
  return tailedLines
    .map(line => {
      try {
        return parseJson(line) as StructuredRecord;
      } catch {
        return null;
      }
    })
    .filter((record): record is StructuredRecord => record !== null)
    .filter(record => matchesStructuredFilters(record, cutoffTime, filters));
}

function tailDebugLogLines(filePath: string, cutoffTime: number): Promise<string[]> {
  return new Promise((resolve) => {
    if (!fs.existsSync(filePath)) {
      resolve([]);
      return;
    }

    const tail = spawn('tail', ['-n', '2000', filePath]);
    let output = '';

    const watchdog = setTimeout(() => {
      tail.kill();
      resolve([]);
    }, TAIL_TIMEOUT_MS);

    tail.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });

    tail.on('close', () => {
      clearTimeout(watchdog);
      const filtered = output.split('\n').filter(line => {
        if (!line.trim()) return false;
        const match = line.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/);
        if (!match) return false;
        const lineTime = Date.parse(match[1]);
        return Number.isFinite(lineTime) && lineTime >= cutoffTime;
      });
      resolve(filtered);
    });

    tail.on('error', () => {
      clearTimeout(watchdog);
      resolve([]);
    });
  });
}

export function createLogRoutes(): Router {
  const router = Router();
  const logger = createLogger('LogRoutes');

  // Check for rotation on startup
  rotateDebugLogIfNeeded();

  logStreamBuffer.setMaxListeners(LOG_STREAM_MAX_LISTENERS);

  // POST endpoint for browser to send debug logs
  router.post('/debug', (req: Request & RequestWithRequestId, res) => {
    const { logs, source = 'browser' } = req.body as { logs: Array<{ level: string; message: string; timestamp: string; data?: unknown }>; source?: string };

    if (!Array.isArray(logs)) {
      return res.status(400).json({ error: 'logs must be an array' });
    }

    try {
      const timestamp = new Date().toISOString();
      const lines = logs.map(log => {
        const dataStr = log.data ? ` ${JSON.stringify(log.data)}` : '';
        return `[${log.timestamp || timestamp}] [${source.toUpperCase()}] [${log.level}] ${log.message}${dataStr}`;
      });

      // Append to debug log file
      fs.appendFileSync(DEBUG_LOG_PATH, lines.join('\n') + '\n');

      res.json({ received: logs.length });
    } catch (error) {
      logger.error('Failed to write debug logs', error);
      res.status(500).json({ error: 'Failed to write logs' });
    }
  });

  // Clear the debug log file
  router.delete('/debug', (_req, res) => {
    try {
      fs.writeFileSync(DEBUG_LOG_PATH, `--- Debug log cleared at ${new Date().toISOString()} ---\n`);
      res.json({ ok: true });
    } catch (error) {
      logger.error('Failed to clear debug log', error);
      res.status(500).json({ error: 'Failed to clear log' });
    }
  });

  router.post('/incidents', (req: Request & RequestWithRequestId, res) => {
    const { incidents } = req.body as {
      incidents?: Array<{
        type: string;
        severity: 'warn' | 'error';
        message?: string;
        route?: string;
        traceId?: string;
        conversationId?: string;
        sessionId?: string;
        streamingId?: string;
        details?: Record<string, unknown>;
      }>;
    };

    if (!Array.isArray(incidents)) {
      return res.status(400).json({ error: 'incidents must be an array' });
    }

    try {
      getBrowserIncidentLog().recordMany(incidents);
      incidents
        .filter(incident => incident.severity === 'error')
        .forEach((incident) => {
          getEventJournal().record({
            event: `browser.${incident.type}`,
            severity: 'error',
            component: 'BrowserIncidents',
            traceId: incident.traceId,
            conversationId: incident.conversationId,
            sessionId: incident.sessionId,
            streamingId: incident.streamingId,
            fields: {
              route: incident.route,
              message: incident.message,
              ...(incident.details || {}),
            },
          });
        });
      res.json({ received: incidents.length });
    } catch (error) {
      logger.error('Failed to persist browser incidents', error);
      res.status(500).json({ error: 'Failed to write incidents' });
    }
  });

  // Get recent logs
  router.get('/recent', (req: Request<Record<string, never>, unknown, Record<string, never>, { limit?: number }> & RequestWithRequestId, res) => {
    const requestId = req.requestId;
    const limit = req.query.limit !== undefined ? req.query.limit : 100;
    
    logger.debug('Get recent logs request', {
      requestId,
      limit
    });
    
    try {
      const logs = logStreamBuffer.getRecentLogs(limit);
      res.json({ logs });
    } catch (error) {
      logger.error('Failed to get recent logs', error, { requestId });
      res.status(500).json({ error: 'Failed to retrieve logs' });
    }
  });
  
  // Export recent logs for bug reports from structured sources
  router.get('/export', asyncHandler(async (
    req: Request<Record<string, never>, unknown, Record<string, never>, {
      minutes?: string;
      conversationId?: string;
      sessionId?: string;
      streamingId?: string;
      traceId?: string;
      includeDebug?: string;
    }> & RequestWithRequestId,
    res
  ) => {
    const minutes = parsePositiveIntQuery(req.query.minutes, { defaultValue: 10 }) ?? 10;
    const cutoffTime = Date.now() - (minutes * 60 * 1000);
    const filters: ExportFilters = {
      conversationId: req.query.conversationId,
      sessionId: req.query.sessionId,
      streamingId: req.query.streamingId,
      traceId: req.query.traceId,
    };
    const includeDebug = String(req.query.includeDebug) === 'true';

    const sections: string[] = [];
    sections.push(`=== Lattice Debug Log Export ===`);
    sections.push(`Generated: ${new Date().toISOString()}`);
    sections.push(`Time range: Last ${minutes} minutes`);
    if (filters.conversationId) sections.push(`Conversation: ${filters.conversationId}`);
    if (filters.sessionId) sections.push(`Session: ${filters.sessionId}`);
    if (filters.streamingId) sections.push(`Streaming: ${filters.streamingId}`);
    if (filters.traceId) sections.push(`Trace: ${filters.traceId}`);
    sections.push('');

    const [
      serverRecords,
      daemonRecords,
      eventJournalRecords,
      permissionRecords,
      browserIncidentRecords,
      connectionDebugRecords,
      debugLines,
    ] = await Promise.all([
      tailStructuredRecords(SERVER_JSONL_LOG_PATH, 3000, cutoffTime, filters),
      tailStructuredRecords(DAEMON_JSONL_LOG_PATH, 1500, cutoffTime, filters),
      tailStructuredRecords(EVENT_JOURNAL_PATH, 2000, cutoffTime, filters),
      tailStructuredRecords(PERMISSION_LOG_PATH, 1000, cutoffTime, filters),
      tailStructuredRecords(BROWSER_INCIDENTS_LOG_PATH, 1000, cutoffTime, filters),
      includeDebug
        ? tailStructuredRecords(CONNECTION_DEBUG_LOG_PATH, 1000, cutoffTime, filters)
        : Promise.resolve([]),
      includeDebug
        ? tailDebugLogLines(DEBUG_LOG_PATH, cutoffTime)
        : Promise.resolve([]),
    ]);

    const pushSection = (title: string, lines: string[]): void => {
      if (lines.length === 0) return;
      sections.push(title);
      sections.push(...lines);
      sections.push('');
    };

    pushSection('=== Server Operational Log (JSONL) ===', serverRecords.map(record => JSON.stringify(record)));
    pushSection('=== Daemon Operational Log (JSONL) ===', daemonRecords.map(record => JSON.stringify(record)));
    pushSection('=== Event Journal (JSONL) ===', eventJournalRecords.map(record => JSON.stringify(record)));
    pushSection('=== Permission Events (JSONL) ===', permissionRecords.map(record => JSON.stringify(record)));
    pushSection('=== Browser Incidents (JSONL) ===', browserIncidentRecords.map(record => JSON.stringify(record)));
    pushSection('=== Connection Debug (JSONL) ===', connectionDebugRecords.map(record => JSON.stringify(record)));
    pushSection('=== Browser Debug Console (opt-in) ===', debugLines);

    const permissionLog = getPermissionEventLog();
    const stats = permissionLog.getPatternStats();
    sections.push('=== Permission Stats (In-Memory Snapshot) ===');
    sections.push(`totalRequests=${stats.totalRequests}`);
    sections.push(`autoApproved=${stats.autoApproved}`);
    sections.push(`manualApproved=${stats.manualApproved}`);
    sections.push(`denied=${stats.denied}`);
    sections.push(`patternHitRate=${(stats.patternHitRate * 100).toFixed(1)}%`);
    sections.push('');

    const exportContent = sections.join('\n');

    // Return as downloadable file
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="lattice-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt"`);
    res.send(exportContent);
  }));

  // Receive browser console.warn/error entries and persist to JSONL
  router.post('/console', (req: Request & RequestWithRequestId, res) => {
    const { entries } = req.body as {
      entries?: Array<{
        level: 'warn' | 'error';
        message: string;
        timestamp: string;
        route?: string;
        conversationId?: string;
        sessionId?: string;
        args?: unknown[];
      }>;
    };

    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: 'entries must be a non-empty array' });
    }

    try {
      for (const entry of entries) {
        appendJsonlRecord(BROWSER_CONSOLE_LOG_PATH, {
          ts: entry.timestamp || new Date().toISOString(),
          source: 'browser-console',
          level: entry.level,
          message: entry.message,
          route: entry.route,
          conversationId: entry.conversationId,
          sessionId: entry.sessionId,
          args: entry.args,
        });
      }
      res.json({ received: entries.length });
    } catch (error) {
      logger.error('Failed to persist browser console entries', error);
      res.status(500).json({ error: 'Failed to write console entries' });
    }
  });

  // Unified timeline — merges all JSONL sources sorted by timestamp.
  // Returns a single chronological array for cross-source correlation.
  router.get('/timeline', asyncHandler(async (
    req: Request<Record<string, never>, unknown, Record<string, never>, {
      minutes?: string;
      limit?: string;
      level?: string;
      conversationId?: string;
      sessionId?: string;
      streamingId?: string;
      traceId?: string;
      sources?: string;
    }> & RequestWithRequestId,
    res
  ) => {
    const minutes = parsePositiveIntQuery(req.query.minutes, { defaultValue: 5 }) ?? 5;
    const limit = parsePositiveIntQuery(req.query.limit, { defaultValue: 500 }) ?? 500;
    const levelFilter = req.query.level; // 'warn', 'error', or undefined (all)
    const cutoffTime = Date.now() - (minutes * 60 * 1000);
    const filters: ExportFilters = {
      conversationId: req.query.conversationId,
      sessionId: req.query.sessionId,
      streamingId: req.query.streamingId,
      traceId: req.query.traceId,
    };

    // Parse source filter (comma-separated, e.g. "server,events,browser")
    const sourcesParam = req.query.sources;
    const requestedSources = sourcesParam
      ? new Set(sourcesParam.split(',').map(s => s.trim()))
      : null; // null = all sources

    type SourceName = 'server' | 'daemon' | 'events' | 'browser-incidents' | 'browser-console' | 'permissions';
    const sourceConfigs: Array<{ name: SourceName; path: string; tailLines: number }> = [
      { name: 'server', path: SERVER_JSONL_LOG_PATH, tailLines: 2000 },
      { name: 'daemon', path: DAEMON_JSONL_LOG_PATH, tailLines: 1000 },
      { name: 'events', path: EVENT_JOURNAL_PATH, tailLines: 1500 },
      { name: 'browser-incidents', path: BROWSER_INCIDENTS_LOG_PATH, tailLines: 500 },
      { name: 'browser-console', path: BROWSER_CONSOLE_LOG_PATH, tailLines: 500 },
      { name: 'permissions', path: PERMISSION_LOG_PATH, tailLines: 500 },
    ];

    const activeSources = requestedSources
      ? sourceConfigs.filter(s => requestedSources.has(s.name))
      : sourceConfigs;

    const results = await Promise.all(
      activeSources.map(async ({ name, path: filePath, tailLines: lines }) => {
        const records = await tailStructuredRecords(filePath, lines, cutoffTime, filters);
        return records.map(record => ({
          ...record,
          _source: name,
          _ts: parseRecordTimestamp(record) ?? 0,
        }));
      })
    );

    let merged = results.flat();

    // Filter by severity/level if requested
    if (levelFilter) {
      const levels = new Set(levelFilter.split(','));
      merged = merged.filter(r => {
        const recordLevel = r.level ?? r.severity ?? 'info';
        return levels.has(recordLevel);
      });
    }

    // Sort by timestamp ascending
    merged.sort((a, b) => a._ts - b._ts);

    // Apply limit (take most recent)
    if (merged.length > limit) {
      merged = merged.slice(merged.length - limit);
    }

    res.json({
      count: merged.length,
      timeRange: { from: new Date(cutoffTime).toISOString(), to: new Date().toISOString() },
      entries: merged,
    });
  }));

  // Stream logs via SSE
  router.get('/stream', (req: RequestWithRequestId, res) => {
    const requestId = req.requestId;
    
    logger.debug('Log stream connection request', {
      requestId,
      headers: {
        'accept': req.headers.accept,
        'user-agent': req.headers['user-agent']
      }
    });
    
    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no' // Disable proxy buffering
    });
    
    // Send initial connection confirmation
    res.write('data: {"type":"connected"}\n\n');
    
    // Create log listener
    const logListener = (logLine: string) => {
      res.write(`data: ${logLine}\n\n`);
    };
    
    // Subscribe to log events
    logStreamBuffer.on('log', logListener);
    
    // Handle client disconnect
    req.on('close', () => {
      logger.debug('Log stream connection closed', { requestId });
      logStreamBuffer.removeListener('log', logListener);
    });
    
    // Send heartbeat every 30 seconds to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(':heartbeat\n\n');
    }, 30000);
    
    // Clean up heartbeat on disconnect
    req.on('close', () => {
      clearInterval(heartbeat);
    });
  });

  return router;
}
