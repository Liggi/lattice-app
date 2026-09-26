import { appendJsonlRecord, BROWSER_INCIDENTS_LOG_PATH } from './infrastructure/structured-log-files.js';

export type BrowserIncidentSeverity = 'warn' | 'error';

export interface BrowserIncidentRecord {
  ts: string;
  type: string;
  severity: BrowserIncidentSeverity;
  message?: string;
  route?: string;
  traceId?: string;
  conversationId?: string;
  sessionId?: string;
  streamingId?: string;
  details?: Record<string, unknown>;
}

class BrowserIncidentLog {
  recordMany(incidents: Array<Omit<BrowserIncidentRecord, 'ts'>>): void {
    const now = new Date().toISOString();
    for (const incident of incidents) {
      appendJsonlRecord(BROWSER_INCIDENTS_LOG_PATH, {
        ts: now,
        ...incident,
      });
    }
  }
}

let instance: BrowserIncidentLog | null = null;

export function getBrowserIncidentLog(): BrowserIncidentLog {
  if (!instance) {
    instance = new BrowserIncidentLog();
  }
  return instance;
}
