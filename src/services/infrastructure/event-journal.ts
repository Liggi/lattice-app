import { appendJsonlRecord, EVENT_JOURNAL_PATH } from './structured-log-files.js';

export type EventJournalSeverity = 'info' | 'warn' | 'error';

export interface EventJournalRecord {
  ts: string;
  event: string;
  severity?: EventJournalSeverity;
  component?: string;
  message?: string;
  traceId?: string;
  requestId?: string;
  conversationId?: string;
  sessionId?: string;
  streamingId?: string;
  provider?: string;
  fields?: Record<string, unknown>;
}

class EventJournal {
  record(record: Omit<EventJournalRecord, 'ts'>): void {
    appendJsonlRecord(EVENT_JOURNAL_PATH, {
      ts: new Date().toISOString(),
      severity: 'info',
      ...record,
    });
  }
}

let instance: EventJournal | null = null;

export function getEventJournal(): EventJournal {
  if (!instance) {
    instance = new EventJournal();
  }
  return instance;
}
