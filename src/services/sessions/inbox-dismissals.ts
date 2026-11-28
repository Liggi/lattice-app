/**
 * Local persistence for dismissed Inbox alerts (`failing-pr`, `failed-run`,
 * `stalled-job`). Each dismissal is keyed by item id plus a signature of the
 * alert's current state (failed checks, failure timestamp/message, stall
 * count), so a dismissed alert stays quiet until its state changes — if a new
 * check fails or a fresh run breaks, it surfaces again.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { InboxItem } from '../../types/inbox-feed.js';
import { CONFIG_DIR } from '../../utils/constants.js';
import { parseJson } from '../../utils/json.js';
import { createLogger } from '../infrastructure/logger.js';

const logger = createLogger('InboxDismissals');

const KEEP_MS = 30 * 24 * 60 * 60_000;

interface DismissedEntry {
  signature: string;
  at: number;
}

/** State signature for dismissible alert items; null for questions/calls (which have their own dismiss/park). */
export function alertSignature(item: InboxItem): string | null {
  if (item.kind === 'failing-pr') {
    const checks = [...(item.pr?.failedChecks ?? [])].sort().join(',');
    return `pr:${checks || item.reason}`;
  }
  if (item.kind === 'failed-run') {
    return `run:${item.since}:${item.detail ?? ''}`;
  }
  if (item.kind === 'stalled-job') {
    return `job:${item.since}:${item.detail ?? ''}`;
  }
  return null;
}

export class InboxDismissalStore {
  private entries: Map<string, DismissedEntry> | null = null;

  constructor(private readonly file: string) {}

  private load(): Map<string, DismissedEntry> {
    if (this.entries) return this.entries;
    const map = new Map<string, DismissedEntry>();
    try {
      if (fs.existsSync(this.file)) {
        const parsed = parseJson(fs.readFileSync(this.file, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [id, raw] of Object.entries(parsed as Record<string, unknown>)) {
            if (raw && typeof raw === 'object' && typeof (raw as DismissedEntry).signature === 'string' && typeof (raw as DismissedEntry).at === 'number') {
              map.set(id, { signature: (raw as DismissedEntry).signature, at: (raw as DismissedEntry).at });
            }
          }
        }
      }
    } catch (err) {
      logger.warn('Could not read inbox dismissals; starting empty', { error: err instanceof Error ? err.message : String(err) });
    }
    this.entries = map;
    return map;
  }

  private save(now = Date.now()): void {
    const map = this.load();
    const cutoff = now - KEEP_MS;
    const out: Record<string, DismissedEntry> = {};
    for (const [id, entry] of map) {
      if (entry.at < cutoff) {
        map.delete(id);
        continue;
      }
      out[id] = entry;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      logger.warn('Could not persist inbox dismissals', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  isDismissed(id: string, signature: string): boolean {
    return this.load().get(id)?.signature === signature;
  }

  dismiss(id: string, signature: string, now = Date.now()): void {
    this.load().set(id, { signature, at: now });
    this.save(now);
  }

  restore(id: string): boolean {
    const removed = this.load().delete(id);
    if (removed) this.save();
    return removed;
  }
}

let shared: InboxDismissalStore | null = null;

export function inboxDismissals(): InboxDismissalStore {
  shared ??= new InboxDismissalStore(path.join(CONFIG_DIR, 'inbox-dismissals.json'));
  return shared;
}
