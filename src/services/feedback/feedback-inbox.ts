/**
 * The feedback inbox on the collector owner's own Lattice.
 *
 * It exists only when a read-token file is present on this machine:
 * `<config dir>/feedback-inbox.json`, `{ "collectorUrl": "...", "readToken": "..." }`,
 * mode 0600. The token is read here and nowhere else — not into config.json,
 * the browser, or any agent's environment — and it is only ever sent to the
 * exact collector origin written beside it, never across a redirect.
 *
 * The server pulls the collector's change feed (a monotonic cursor, so a
 * reclassification or deletion arrives as a newer change) into a local cache,
 * when the page asks and the last pull is over a minute old. Read and Done are
 * local; the collector's key is read-only.
 */

import fs from 'fs';
import path from 'path';
import { CONFIG_DIR } from '@/utils/constants.js';
import { parseJson } from '@/utils/json.js';
import { collectorOriginOf, FeedbackError } from './feedback-service.js';
import type {
  FeedbackClassificationState,
  FeedbackInboxItem,
  FeedbackInboxResponse,
  FeedbackInboxView,
} from '@/types/feedback.js';

export const INBOX_TOKEN_FILE = path.join(CONFIG_DIR, 'feedback-inbox.json');

const REFRESH_INTERVAL_MS = 55_000;
const PAGE_LIMIT = 200;
const MAX_PAGES_PER_REFRESH = 50;
const REQUEST_TIMEOUT_MS = 15_000;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

type CollectorItem = Omit<FeedbackInboxItem, 'readAt' | 'doneAt'>;

interface InboxCache {
  origin: string;
  cursor: number;
  items: Record<string, CollectorItem>;
  local: Record<string, { readAt?: string; doneAt?: string }>;
  lastRefreshAt: string | null;
  lastAttemptAt: string | null;
  refreshError: string | null;
}

interface InboxCredentials {
  origin: string;
  token: string;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** A collector feed item in the shape the inbox shows, or null if malformed. */
function parseItem(raw: Record<string, unknown>): CollectorItem | null {
  const id = str(raw.id);
  const receivedAt = str(raw.received_at);
  const message = str(raw.message);
  if (!id || !receivedAt || message === null) return null;
  const state = str(raw.classification_state);
  return {
    id,
    receivedAt,
    source: raw.source === 'agent' ? 'agent' : 'human',
    category: raw.category === 'bug' || raw.category === 'suggestion' ? raw.category : 'other',
    message,
    scope: raw.scope === 'session' ? 'session' : 'app',
    screen: str(raw.screen) ?? 'other',
    sessionRef: str(raw.session_ref),
    installId: str(raw.install_id) ?? '',
    latticeVersion: str(raw.lattice_version) ?? '',
    provider: str(raw.provider),
    model: str(raw.model),
    classificationState: (state === 'classified' || state === 'failed' ? state : 'pending') as FeedbackClassificationState,
    offTopic: bool(raw.off_topic),
    abusive: bool(raw.abusive),
    classificationReason: str(raw.classification_reason),
  };
}

export class FeedbackInbox {
  private readonly cachePath: string;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly tokenFile: string = INBOX_TOKEN_FILE,
    dir: string = path.join(CONFIG_DIR, 'feedback'),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.cachePath = path.join(dir, 'inbox-cache.json');
  }

  /** Whether this Lattice has an inbox at all: the token file exists. */
  available(): boolean {
    return fs.existsSync(this.tokenFile);
  }

  private credentials(): InboxCredentials {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.tokenFile);
    } catch {
      throw new FeedbackError('This Lattice has no feedback inbox.', 404, 'no_inbox');
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new FeedbackError(
        `${this.tokenFile} can be read by other users on this machine. Run: chmod 600 ${this.tokenFile}`,
        500,
        'inbox_token_exposed',
      );
    }
    const parsed = parseJson(fs.readFileSync(this.tokenFile, 'utf-8')) as { collectorUrl?: unknown; readToken?: unknown };
    const url = str(parsed.collectorUrl);
    const token = str(parsed.readToken);
    if (!url || !token) {
      throw new FeedbackError(`${this.tokenFile} needs "collectorUrl" and "readToken".`, 500, 'inbox_token_invalid');
    }
    const origin = collectorOriginOf(url);
    if ('problem' in origin) throw new FeedbackError(`${this.tokenFile}: ${origin.problem}`, 500, 'inbox_token_invalid');
    return { origin: origin.origin, token };
  }

  private load(origin: string): InboxCache {
    try {
      const cache = parseJson(fs.readFileSync(this.cachePath, 'utf-8')) as InboxCache;
      if (cache.origin === origin) return cache;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // A different collector is a different feed: its cursor means nothing here.
    return { origin, cursor: 0, items: {}, local: {}, lastRefreshAt: null, lastAttemptAt: null, refreshError: null };
  }

  private save(cache: InboxCache): void {
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true, mode: 0o700 });
    const temp = `${this.cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(cache), { mode: 0o600 });
    fs.renameSync(temp, this.cachePath);
  }

  private prune(cache: InboxCache, now: number): void {
    for (const [id, item] of Object.entries(cache.items)) {
      if (now - Date.parse(item.receivedAt) > RETENTION_MS) {
        delete cache.items[id];
        delete cache.local[id];
      }
    }
  }

  private async pull(credentials: InboxCredentials): Promise<void> {
    const cache = this.load(credentials.origin);
    cache.lastAttemptAt = new Date().toISOString();
    try {
      for (let page = 0; page < MAX_PAGES_PER_REFRESH; page++) {
        const response = await this.fetchImpl(`${credentials.origin}/v1/changes?after=${cache.cursor}&limit=${PAGE_LIMIT}`, {
          headers: { authorization: `Bearer ${credentials.token}` },
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.status === 401) throw new Error('The collector refused the read token (401).');
        if (!response.ok) throw new Error(`The collector answered ${response.status}.`);
        const body = (await response.json()) as { items?: unknown; next_cursor?: unknown; has_more?: unknown };
        if (!Array.isArray(body.items) || typeof body.next_cursor !== 'number') {
          throw new Error('The collector sent a change feed in an unexpected shape.');
        }
        for (const raw of body.items as Array<Record<string, unknown>>) {
          const id = str(raw.id);
          if (!id) continue;
          if (raw.deleted === true) {
            delete cache.items[id];
            delete cache.local[id];
            continue;
          }
          const item = parseItem(raw);
          if (item) cache.items[id] = item;
        }
        cache.cursor = Math.max(cache.cursor, body.next_cursor);
        if (body.has_more !== true) break;
      }
      cache.lastRefreshAt = new Date().toISOString();
      cache.refreshError = null;
    } catch (error) {
      cache.refreshError = error instanceof Error ? error.message : String(error);
    }
    this.prune(cache, Date.now());
    this.save(cache);
  }

  /** Pull if the last attempt is over a minute old; one pull at a time. */
  async refresh(force = false): Promise<void> {
    const credentials = this.credentials();
    const cache = this.load(credentials.origin);
    const last = cache.lastAttemptAt ? Date.parse(cache.lastAttemptAt) : 0;
    if (!force && Date.now() - last < REFRESH_INTERVAL_MS) return;
    this.inFlight ??= this.pull(credentials).finally(() => { this.inFlight = null; });
    await this.inFlight;
  }

  async list(view: FeedbackInboxView): Promise<FeedbackInboxResponse> {
    await this.refresh();
    const cache = this.load(this.credentials().origin);
    const all: FeedbackInboxItem[] = Object.values(cache.items)
      .map((item) => ({ ...item, readAt: cache.local[item.id]?.readAt ?? null, doneAt: cache.local[item.id]?.doneAt ?? null }))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    const flagged = (item: FeedbackInboxItem) => item.offTopic === true || item.abusive === true;
    const unread = (item: FeedbackInboxItem) => !item.readAt && !item.doneAt;
    const items = view === 'unread' ? all.filter(unread) : view === 'flagged' ? all.filter(flagged) : all;
    return {
      items,
      counts: { unread: all.filter(unread).length, all: all.length, flagged: all.filter(flagged).length },
      lastRefreshAt: cache.lastRefreshAt,
      refreshError: cache.refreshError,
    };
  }

  async unreadCount(): Promise<number> {
    return (await this.list('unread')).counts.unread;
  }

  mark(id: string, changes: { read?: unknown; done?: unknown }): void {
    const cache = this.load(this.credentials().origin);
    if (!cache.items[id]) throw new FeedbackError(`No feedback item ${id}.`, 404, 'unknown_item');
    const local = (cache.local[id] ??= {});
    const now = new Date().toISOString();
    if (changes.read === true) local.readAt ??= now;
    if (changes.read === false) { delete local.readAt; delete local.doneAt; }
    if (changes.done === true) { local.doneAt ??= now; local.readAt ??= now; }
    if (changes.done === false) delete local.doneAt;
    this.save(cache);
  }
}
