/**
 * Read-only HTTP API over the past-session corpus stored in
 * `~/.lattice/session-info.db` (`harness_events`, `session_summaries`,
 * `sessions`, `conversations`).
 *
 * Mounted at `/api/sessions`. Sibling of session-status / session-transfer
 * routes; uses the shared `session-history` module so the CLI and the HTTP
 * surface render the same content.
 *
 * Route order: literal paths (`/`, `/search`) precede the `/:conv` handlers
 * within this router so Express does not greedily capture them.
 */

import { Router } from 'express';
import { asyncHandler } from '@/middleware/error-handler.js';
import {
  getEvent,
  getEventCount,
  getEventTypeCounts,
  getEvents,
  getSessionMetadata,
  getSessionSummary,
  listSessions,
  searchSessions,
  setArchived,
} from '@/session-history/repository.js';
import {
  GREP_ROLES,
  projectGrep,
  projectInputs,
  projectTools,
  projectTranscript,
  projectUsage,
  renderEvent,
  renderGrep,
  renderInputs,
  renderList,
  renderShow,
  renderTools,
  renderTranscript,
} from '@/session-history/renderer.js';
import type { ListOptions } from '@/session-history/repository.js';
import type { GrepRole, TranscriptOptions, ToolsOptions } from '@/session-history/renderer.js';

// Note: an upstream queryParser middleware (src/middleware/query-parser.ts)
// auto-coerces numeric query strings to JS numbers, so values can land here
// as either string or number depending on shape. Handle both.
function asInt(value: unknown, fallback?: number): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const n = parseInt(value, 10);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
}

function asStr(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function isFlagOn(value: unknown): boolean {
  return value === true || value === '1' || value === 1 || value === 'true';
}

function isTextFormat(req: { query: Record<string, unknown> }): boolean {
  return req.query.format === 'text';
}

function sendText(res: import('express').Response, body: string): void {
  res.type('text/plain; charset=utf-8').send(body);
}

export function createSessionHistoryRoutes(): Router {
  const router = Router();

  // ---- Literal paths first ---------------------------------------------------

  // GET /api/sessions/history-search?q=...
  // Naming: `history-search` so we don't preempt a future top-level
  // `/api/sessions/search`. Substring match across first messages and summaries; FTS5 later.
  router.get(
    '/history-search',
    asyncHandler(async (req, res) => {
      const q = asStr(req.query.q);
      if (!q) {
        res.status(400).json({ error: 'missing required query param: q' });
        return;
      }
      const limit = asInt(req.query.limit, 30) ?? 30;
      // Same search the CLI's `lattice session search` runs — one implementation
      // so the two surfaces cannot drift on what counts as a match. Response
      // shape is unchanged (the list items); `?hits=1` asks for the match
      // context alongside them.
      const hits = searchSessions(q, { limit });
      if (isFlagOn(req.query.hits)) {
        res.json(hits);
        return;
      }
      res.json(hits.map((hit) => hit.item));
    }),
  );

  // GET /api/sessions/history?limit=N&all=1&archived=1
  // (Path is `/history` rather than `/` — `/api/sessions/` is a busy root.)
  router.get(
    '/history',
    asyncHandler(async (req, res) => {
      const opts: ListOptions = {
        limit: asInt(req.query.limit, 30),
        includeArchived: isFlagOn(req.query.all) || isFlagOn(req.query.archived),
        onlyArchived: isFlagOn(req.query.archived),
      };
      const project = asStr(req.query.project);
      if (project) opts.project = project;
      const tag = asStr(req.query.tag);
      if (tag) opts.tag = tag;

      const items = listSessions(opts);
      if (isTextFormat(req)) {
        sendText(res, renderList(items));
        return;
      }
      res.json(items);
    }),
  );

  // ---- :conversationId-scoped paths ------------------------------------------
  //
  // Use `/:conv/history/...` so we don't claim the bare `/:conv` slot, which
  // is more likely to be wanted by status / segment / mutation surfaces.

  router.get(
    '/:conv/history',
    asyncHandler(async (req, res) => {
      const conv = req.params.conv;
      const metadata = getSessionMetadata(conv);
      if (!metadata) {
        res.status(404).json({ error: `no metadata for conversation ${conv}` });
        return;
      }
      const summary = getSessionSummary(conv);
      const eventCount = getEventCount(conv);
      const eventTypeCounts = getEventTypeCounts(conv);
      const usageEvents = getEvents(conv, { types: ['turn:end'] });
      const usage = projectUsage(usageEvents);

      if (isTextFormat(req)) {
        sendText(res, renderShow({ metadata, summary, eventCount, eventTypeCounts, usage }));
        return;
      }
      res.json({ metadata, summary, eventCount, eventTypeCounts, usage });
    }),
  );

  router.get(
    '/:conv/history/inputs',
    asyncHandler(async (req, res) => {
      const conv = req.params.conv;
      const events = getEvents(conv, {
        fromSeq: asInt(req.query.from),
        toSeq: asInt(req.query.to),
        types: ['input:sent'],
      });
      const lines = projectInputs(events);
      if (isTextFormat(req)) {
        sendText(res, renderInputs(lines));
        return;
      }
      res.json(lines);
    }),
  );

  router.get(
    '/:conv/history/transcript',
    asyncHandler(async (req, res) => {
      const conv = req.params.conv;
      const events = getEvents(conv, {
        fromSeq: asInt(req.query.from),
        toSeq: asInt(req.query.to),
        types: ['input:sent', 'content'],
      });
      const opts: TranscriptOptions = {
        includeThinking: isFlagOn(req.query['include-thinking']),
        raw: isFlagOn(req.query.raw),
      };
      const lines = projectTranscript(events, opts);
      if (isTextFormat(req)) {
        sendText(res, renderTranscript(lines));
        return;
      }
      res.json(lines);
    }),
  );

  router.get(
    '/:conv/history/tools',
    asyncHandler(async (req, res) => {
      const conv = req.params.conv;
      const events = getEvents(conv, {
        fromSeq: asInt(req.query.from),
        toSeq: asInt(req.query.to),
        types: ['content', 'result'],
      });
      const opts: ToolsOptions = {};
      const name = asStr(req.query.name);
      if (name) opts.nameFilter = name;
      const calls = projectTools(events, opts);
      if (isTextFormat(req)) {
        sendText(res, renderTools(calls));
        return;
      }
      res.json(calls);
    }),
  );

  router.get(
    '/:conv/history/events/:seq',
    asyncHandler(async (req, res) => {
      const conv = req.params.conv;
      const seq = parseInt(req.params.seq, 10);
      if (Number.isNaN(seq)) {
        res.status(400).json({ error: 'seq must be an integer' });
        return;
      }
      const event = getEvent(conv, seq);
      if (!event) {
        res.status(404).json({ error: `no event at seq ${seq} in ${conv}` });
        return;
      }
      if (isTextFormat(req)) {
        sendText(res, renderEvent(event));
        return;
      }
      res.json(event);
    }),
  );

  router.get(
    '/:conv/history/grep',
    asyncHandler(async (req, res) => {
      const q = asStr(req.query.q);
      if (!q) {
        res.status(400).json({ error: 'missing required query param: q' });
        return;
      }
      const conv = req.params.conv;
      const events = getEvents(conv, { types: ['input:sent', 'content', 'result'] });
      const role = asStr(req.query.role);
      const roles = role
        ? (role.split(',').map((r) => r.trim().toLowerCase()).filter((r) =>
            (GREP_ROLES as ReadonlyArray<string>).includes(r),
          ) as GrepRole[])
        : undefined;
      const hits = projectGrep(events, q, roles && roles.length > 0 ? { roles } : {});
      if (isTextFormat(req)) {
        sendText(res, renderGrep(hits, q));
        return;
      }
      res.json(hits);
    }),
  );

  // Mutations: archive / unarchive
  router.post(
    '/:conv/history/archive',
    asyncHandler(async (req, res) => {
      const conv = req.params.conv;
      const changed = setArchived(conv, true);
      if (!changed) {
        res.status(404).json({ error: `no session row for ${conv}` });
        return;
      }
      res.json({ conversationId: conv, archived: true });
    }),
  );

  router.post(
    '/:conv/history/unarchive',
    asyncHandler(async (req, res) => {
      const conv = req.params.conv;
      const changed = setArchived(conv, false);
      if (!changed) {
        res.status(404).json({ error: `no session row for ${conv}` });
        return;
      }
      res.json({ conversationId: conv, archived: false });
    }),
  );

  return router;
}
