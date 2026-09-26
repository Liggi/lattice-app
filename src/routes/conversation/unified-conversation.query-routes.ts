import type { Provider } from '@/types/unified-messages.js';
import type { Response, Router } from 'express';
import { asyncHandler } from '@/middleware/error-handler.js';
import { RequestWithRequestId } from '@/types/express.js';
import {
  LatticeError,
  type ConversationDetailsResponse,
  type ConversationMessage,
} from '@/types/index.js';
import { SessionBranchService } from '@/services/sessions/session-branch-service.js';
import type {
  Conversation,
  ConversationSegment,
  ConversationService,
} from '@/services/sessions/conversation-service.js';
import type { SessionInfoService } from '@/services/sessions/session-info-service.js';
import type { ClaudeHistoryReader } from '@/services/sessions/claude-history-reader.js';
import { readMessages, readMessagesTail, countMessages } from '@/harness/event-message-reader.js';
import type { ActiveConversationRegistry } from '@/services/process/active-conversation-registry.js';
import type { InsightsEngine } from '@/services/insights/insights-engine.js';
import { mapUnifiedMessageToConversationMessage } from '@/services/sessions/unified-message-mapper.js';
import { thumbnailImageBlocks } from '@/services/sessions/message-truncation.js';
import { createLogger } from '@/services/infrastructure/logger.js';
import { readWorkerHistory, readWorkerStates } from '@/services/sessions/worker-events.js';
import { latestWorkerItemReached, unreadInboxSummaries } from '@/services/sessions/session-inbox.js';
import { conversationContextTokens } from '@/services/sessions/context-compaction.js';
import type { ProjectStateResponse, WorkerCardState, WorkersResponse } from '@/types/worker-events.js';
import { readWorkerActivity } from '@/services/sessions/worker-activity.js';
import { readWorkerRuntime } from '@/services/sessions/worker-runtime.js';
import { archiveFinishedWorkers } from '@/services/sessions/worker-auto-archive.js';
import { appendProjectNote, readProjectState } from '@/services/sessions/project-state.js';
import { backfillProjectName } from '@/services/sessions/project-name.js';
import { normalizeProjectName } from '@/services/insights/anthropic-service.js';
import { moveThread, moveWorker, ProjectMoveError } from '@/services/sessions/project-move.js';
import { senderIdentities } from '@/services/sessions/sender-identity.js';
import {
  PROJECT_NOTE_KINDS,
  RECONCILE_DISPOSITIONS,
  THREAD_WAIT_KINDS,
  type ProjectNotedData,
  type ProjectOpenThread,
  type ReconcileDisposition,
  type ThreadOwner,
  type ThreadWait,
} from '@/types/project-state.js';

const logger = createLogger('UnifiedConversationQueryRoutes');

const DEFAULT_DETAILS_PAGE_SIZE = 50;
const MAX_DETAILS_PAGE_SIZE = 200;
const DEFAULT_LIST_PAGE_SIZE = 50;
const MAX_LIST_PAGE_SIZE = 200;

// Request coalescing: concurrent identical detail requests share one execution.
const inflightDetails = new Map<string, Promise<ConversationDetailsResponse>>();

// The list is a projection, not the document: every consumer of the first
// prompt renders at most a line or two (session card mission fallback,
// archived-list label, portfolio first line), yet full prompt bodies were
// 272KB of a measured 423KB list payload (2026-08-28). The full text stays on
// the detail route; the list ships a bounded preview under a name that says
// so.
const INITIAL_PROMPT_PREVIEW_CHARS = 300;
function promptPreview(prompt: string | null | undefined): string | null {
  if (!prompt) return null;
  if (prompt.length <= INITIAL_PROMPT_PREVIEW_CHARS) return prompt;
  return `${prompt.slice(0, INITIAL_PROMPT_PREVIEW_CHARS)}…`;
}

class ClientDisconnectedError extends Error {
  constructor() { super('Client disconnected'); this.name = 'ClientDisconnectedError'; }
}

function toPositiveBoundedInt(
  value: unknown,
  fallback: number,
  max: number
): number {
  const normalized = Array.isArray(value) ? (value[0] as unknown) : value;
  const parsed = typeof normalized === 'number'
    ? normalized
    : typeof normalized === 'string'
      ? Number.parseInt(normalized, 10)
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseListCursor(value: unknown): number {
  const normalized = Array.isArray(value) ? (value[0] as unknown) : value;
  const parsed = typeof normalized === 'number'
    ? normalized
    : typeof normalized === 'string'
      ? Number.parseInt(normalized, 10)
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function paginateConversationMessages(
  messages: ConversationMessage[],
  limit?: number,
  before?: string
): {
  messages: ConversationMessage[];
  hasMore: boolean;
  oldestMessageId: string | undefined;
} {
  if (!limit && !before) {
    return {
      messages,
      hasMore: false,
      oldestMessageId: undefined,
    };
  }

  const effectiveLimit = limit || DEFAULT_DETAILS_PAGE_SIZE;
  let endIndex = messages.length;
  if (before) {
    const beforeIndex = messages.findIndex(message => message.uuid === before);
    if (beforeIndex >= 0) {
      endIndex = beforeIndex;
    }
  }
  const startIndex = Math.max(0, endIndex - effectiveLimit);
  const paged = messages.slice(startIndex, endIndex);
  return {
    messages: paged,
    hasMore: startIndex > 0,
    oldestMessageId: paged[0]?.uuid,
  };
}

/** The owner of a thread as it arrives on the wire; null when it is not one of the four shapes. */
function parseOwner(raw: unknown): ThreadOwner | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as { kind?: unknown; worker?: unknown; who?: unknown };
  if (candidate.kind === 'coordinator') return { kind: 'coordinator' };
  if (candidate.kind === 'user') return { kind: 'user' };
  if (candidate.kind === 'worker' && typeof candidate.worker === 'string' && candidate.worker) {
    return { kind: 'worker', worker: candidate.worker };
  }
  if (candidate.kind === 'external' && typeof candidate.who === 'string' && candidate.who.trim()) {
    return { kind: 'external', who: candidate.who.trim() };
  }
  return null;
}

/** What a thread is waiting on. The text is the coordinator's own words; only a worker wait is machine-checkable. */
function parseWait(raw: unknown): ThreadWait | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as { kind?: unknown; text?: unknown; worker?: unknown; thread?: unknown };
  if (typeof candidate.kind !== 'string' || !(THREAD_WAIT_KINDS as readonly string[]).includes(candidate.kind)) return null;
  if (typeof candidate.text !== 'string' || !candidate.text.trim()) return null;
  return {
    kind: candidate.kind as ThreadWait['kind'],
    text: candidate.text.trim(),
    ...(typeof candidate.worker === 'string' && candidate.worker ? { worker: candidate.worker } : {}),
    ...(typeof candidate.thread === 'number' ? { thread: candidate.thread } : {}),
  };
}

export interface UnifiedConversationQueryRoutesContext {
  conversationService: ConversationService;
  sessionInfoService: SessionInfoService;
  historyReader: ClaudeHistoryReader;
  activeConversationRegistry: ActiveConversationRegistry;
  insightsEngine: InsightsEngine;
  findRuntimeActiveSegment: (conversation: Conversation) => ConversationSegment | null;
  getLatestSegmentForFallback: (conversation: Conversation) => ConversationSegment | null;
}

export function registerUnifiedConversationQueryRoutes(
  router: Router,
  context: UnifiedConversationQueryRoutesContext
): void {
  const {
    conversationService,
    sessionInfoService,
    activeConversationRegistry,
    insightsEngine,
    findRuntimeActiveSegment,
    getLatestSegmentForFallback,
  } = context;
  router.get('/', asyncHandler(async (req: RequestWithRequestId, res) => {
    const listStart = Date.now();
    const listTimings: Record<string, number> = {};
    const listMark = (label: string) => { listTimings[label] = Date.now() - listStart; };
    const includeIdentityImageRaw = req.query.includeIdentityImage;
    const includeIdentityImage = typeof includeIdentityImageRaw === 'boolean'
      ? includeIdentityImageRaw
      : typeof includeIdentityImageRaw === 'string'
        ? includeIdentityImageRaw.toLowerCase() !== 'false'
        : true;

    // Parse archived filter — default to excluding archived (matches sidebar behavior).
    // Note: queryParser middleware may have already converted "false"→false, "true"→true,
    // so check for both string and boolean types.
    const archivedRaw = req.query.archived;
    const archivedFilter: boolean | undefined = typeof archivedRaw === 'boolean'
      ? archivedRaw
      : typeof archivedRaw === 'string'
        ? archivedRaw.toLowerCase() === 'true'
        : undefined;
    const listLimit = toPositiveBoundedInt(req.query.limit, DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE);
    const listOffset = parseListCursor(req.query.cursor);

    // Pass archived filter to the DB query so we don't fetch hundreds of
    // archived conversations just to discard them.
    listMark('parse');
    let { conversations, total } = conversationService.listConversations({
      archived: archivedFilter,
      limit: listLimit,
      offset: listOffset,
    });
    listMark('listConversations');

    listMark('reconcile');

    // One batched lookup for the whole page. Previously each row ran two
    // synchronous point queries inside the map below, and every one of them
    // materialized the row's base64 identity_image even when the client had
    // asked for the list without images.
    const latestSegmentByConversation = new Map<string, ConversationSegment | null>();
    const sessionInfoLookupIds: string[] = [];
    for (const conv of conversations) {
      const latestSegment = getLatestSegmentForFallback(conv);
      latestSegmentByConversation.set(conv.conversationId, latestSegment);
      sessionInfoLookupIds.push(conv.conversationId);
      if (latestSegment) sessionInfoLookupIds.push(latestSegment.providerSessionId);
    }
    const sessionInfoById = sessionInfoService.getSessionInfoBatch(sessionInfoLookupIds, {
      includeIdentityImage,
    });
    listMark('sessionInfoBatch');

    // Enrich with session metadata (name, insights, status)
    const enriched = conversations.map(conv => {
      // Conversation-level metadata (archived, pinned) lives on the conv-* row itself.
      // Provider-level metadata (name, insights) comes from the first segment's session.
      const convInfo = sessionInfoById.get(conv.conversationId) ?? null;
      const latestSegment = latestSegmentByConversation.get(conv.conversationId) ?? null;
      const providersUsedSet = new Set(conv.segments.map(segment => segment.provider));
      if (conv.latestProvider) {
        providersUsedSet.add(conv.latestProvider);
      }
      const providersUsed = (['claude', 'codex'] as const).filter(provider => providersUsedSet.has(provider));
      const segmentInfo = latestSegment
        ? sessionInfoById.get(latestSegment.providerSessionId) ?? null
        : null;

      // Check if any segment is currently active at runtime.
      const activeSegment = findRuntimeActiveSegment(conv);
      let status: 'ongoing' | 'completed' = activeSegment ? 'ongoing' : 'completed';
      let streamingId: string | null = activeSegment?.streamingId ?? null;

      return {
        conversationId: conv.conversationId,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        lastActivityAt: conv.lastActivityAt,
        archivedAt: conv.archivedAt ?? null,
        workingDirectory: conv.workingDirectory,
        workspace: conv.workspace,
        teamName: convInfo?.team_name || segmentInfo?.team_name || null,
        teamRole: convInfo?.team_role || segmentInfo?.team_role || null,
        latestProvider: conv.latestProvider,
        providersUsed,
        activeProvider: activeSegment?.provider || latestSegment?.provider || conv.latestProvider || null,
        segmentCount: conv.segments.length,
        status,
        streamingId,
        // Conversation-level: archived/pinned from the conv-* row, falling back to segment.
        // Default archived to TRUE so orphaned conversations (e.g. from test runs that
        // write to the production DB) stay hidden instead of cluttering the sidebar.
        customName: convInfo?.custom_name || segmentInfo?.custom_name || '',
        // Generated from the project's agreed outcome, never from the
        // transcript. Served alongside customName rather than folded into it
        // so the card can keep a user-typed name ahead of a generated one.
        projectName: convInfo?.project_name || null,
        pinned: convInfo?.pinned ?? segmentInfo?.pinned ?? false,
        archived: convInfo?.archived ?? segmentInfo?.archived ?? true,
        pausedReason: convInfo?.paused_reason || segmentInfo?.paused_reason || null,
        importedAt: convInfo?.imported_at || null,
        permissionMode: convInfo?.permission_mode || segmentInfo?.permission_mode || null,
        identityImage: includeIdentityImage
          ? (convInfo?.identity_image || segmentInfo?.identity_image || null)
          : null,
        pinCharacterName: convInfo?.pin_character_name || segmentInfo?.pin_character_name || null,
        // Characters remain stored through unpinning, but only pinned cards need
        // to carry their base64 portrait in the list payload.
        pinCharacterImage: (convInfo?.pinned ?? segmentInfo?.pinned ?? false)
          ? (convInfo?.pin_character_image || segmentInfo?.pin_character_image || null)
          : null,
        initialPromptPreview: promptPreview(conv.initialPrompt),
        // Workers render under their coordinator in the sidebar, not as peers.
        pickedUpFrom: conv.pickedUpFrom,
        coordinator: conv.coordinator,
      };
    });

    listMark('enrich');

    // Fetch cached insights for all conversations and attach to response.
    // Canonical insights are keyed by conversation ID (conv-*).
    const allLookupIds = enriched.map(conv => conv.conversationId);
    let cachedInsights = new Map<string, import('@/services/insights/insights-engine.js').SessionInsights>();
    try {
      cachedInsights = await insightsEngine.getCachedInsightsForSessions(allLookupIds);
    } catch (err) {
      logger.debug('[CONV] Failed to fetch cached insights for list', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    listMark('fetchInsights');
    const enrichedWithInsights = enriched.map(conv => {
      const insights = cachedInsights.get(conv.conversationId) || undefined;
      return { ...conv, insights };
    });

    // Apply server-side archived filter so clients don't receive hundreds of
    // archived conversations they'll just discard.  Without this, every test run
    // creates dozens of conversations that bloat the list response.
    const filtered = archivedFilter !== undefined
      ? enrichedWithInsights.filter(conv => conv.archived === archivedFilter)
      : enrichedWithInsights;

    // Backfill mission + identity image for non-archived sessions in the background.
    const activeConversationIds = filtered
      .filter(conv => !conv.archived)
      .map(conv => conv.conversationId);
    if (activeConversationIds.length > 0) {
      insightsEngine.backfillMissing(activeConversationIds).catch((err: unknown) => {
        logger.warn('[CONV] Mission backfill dispatch failed', {
          count: activeConversationIds.length,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    const nextOffset = listOffset + conversations.length;
    const hasMore = nextOffset < total;
    const nextCursor = hasMore ? String(nextOffset) : null;

    listMark('total');
    const totalMs = Date.now() - listStart;
    if (totalMs > 500) {
      logger.warn('[CONV] Slow list response', { durationMs: totalMs, phases: listTimings, conversationCount: filtered.length });
    }

    res.json({
      conversations: filtered,
      total,
      hasMore,
      nextCursor,
    });
  }));
  // ==========================================================================
  // GET /:conversationId/identity-image — Get sidebar identity image on demand
  // ==========================================================================
  router.get('/:conversationId/identity-image', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { conversationId } = req.params;

    if (!conversationId.startsWith('conv-')) {
      res.status(404).json({ error: 'Not a unified conversation ID' });
      return;
    }

    const conversation = conversationService.getConversation(conversationId);
    if (!conversation) {
      throw new LatticeError('CONVERSATION_NOT_FOUND', `Conversation ${conversationId} not found`, 404);
    }

    const latestSegment = getLatestSegmentForFallback(conversation);
    const identityInfo = sessionInfoService.getSessionInfoBatch(
      [conversationId, ...(latestSegment ? [latestSegment.providerSessionId] : [])],
    );
    const convInfo = identityInfo.get(conversationId) ?? null;
    const segmentInfo = latestSegment
      ? identityInfo.get(latestSegment.providerSessionId) ?? null
      : null;
    const identityImage = convInfo?.identity_image || segmentInfo?.identity_image || null;

    logger.debug('[CONV] Identity image requested', {
      conversationId,
      hasImage: Boolean(identityImage),
      bytes: identityImage?.length || 0,
    });

    res.json({
      conversationId,
      identityImage,
    });
  }));

  // ==========================================================================
  // GET /:conversationId/workers — Workers this coordinator dispatched, with
  // their current phase, folded from the coordinator's full event log. The
  // client's live event window may not reach back to a dispatch, so the
  // panel reads this and refreshes on each worker event it sees.
  // ==========================================================================
  router.get('/:conversationId/workers', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { conversationId } = req.params;
    if (!conversationId.startsWith('conv-')) {
      res.status(404).json({ error: 'Not a unified conversation ID' });
      return;
    }
    if (!conversationService.getConversation(conversationId)) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    // Context size travels with each worker so a heavy one is visible to
    // the user and the coordinator; the server compacts it, nobody manages it.
    // `archived` is the coordinator's call that the worker is done (it
    // archives the session); `reportReached` says whether the latest report
    // or question has been read by one of the coordinator's turns yet.
    const reached = latestWorkerItemReached(conversationId);
    const states = readWorkerStates(conversationId);
    // What each worker's process is doing, asked of the harness rather than
    // inferred from the coordinator's log. The log cannot answer it: it has
    // no event for a process ending, so a worker stopped or exited mid-turn
    // stays `working` there forever (2026-09-21: four cards across two
    // projects read Working with every process dead since 12:30:22).
    const runtimes = new Map(states.map((state) => [state.worker, readWorkerRuntime(state.worker)]));
    const workerInfo = sessionInfoService.getSessionInfoBatch(states.map((state) => state.worker), { includeIdentityImage: false });
    // What each worker has waiting and how old the oldest is, so a coordinator
    // reading its roster before the next dispatch can see that an earlier
    // instruction has not landed. One grouped query answers for the whole
    // roster, which a per-worker check cannot do at forty workers.
    const unread = unreadInboxSummaries(states.map((state) => state.worker), conversationId);
    const workers: WorkerCardState[] = states.map((state) => ({
      ...state,
      contextTokens: conversationContextTokens(state.worker),
      archived: Boolean(workerInfo.get(state.worker)?.archived),
      reportReached: reached.get(state.worker) ?? false,
      runtime: runtimes.get(state.worker) ?? 'unknown',
      // An idle worker with something in its inbox is about to run again, so
      // the card can say that rather than calling it stopped.
      queued: unread.has(state.worker),
      // Present tense, so it is only served for the turn it was written from
      // and only while a turn is actually in progress; a question or report
      // replaces it. A stopped or exited process gets none: the last phrase
      // it wrote is not what it is doing, it is what it was doing when it
      // stopped.
      activity: runtimes.get(state.worker) === 'working'
        ? readWorkerActivity(state.worker, state.phase)
        : null,
    }));
    const project = conversationService.getConversation(conversationId)?.coordinator ? readProjectState(conversationId) : null;
    // Names for the sessions that have written to this one, so a message from
    // another session says who sent it rather than showing its id. Served
    // here because the panel already refetches this on every worker event and
    // status change, which is when a new sender appears.
    res.json({
      workers,
      history: readWorkerHistory(conversationId),
      project,
      senders: senderIdentities(conversationId),
      unread: Object.fromEntries(unread),
    } satisfies WorkersResponse);
  }));

  // ==========================================================================
  // GET /:conversationId/project — the coordinator's noted project state
  // (outcome, decisions, open threads, what the current turn is doing) and
  // the nudge count. POST /:conversationId/project/note appends one note;
  // `lattice session note` is its client. See types/project-state.ts.
  // ==========================================================================
  router.get('/:conversationId/project', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { conversationId } = req.params;
    const conversation = conversationService.getConversation(conversationId);
    if (!conversationId.startsWith('conv-') || !conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    if (!conversation.coordinator) {
      res.status(400).json({ error: 'Not a coordinator conversation' });
      return;
    }
    // The same unread facts as the roster, for the workers carrying open
    // threads: `state` is the other place a coordinator looks before it sends.
    const state = readProjectState(conversationId);
    const carrying = [...new Set(state.open.flatMap((thread) => [
      ...(thread.owner?.kind === 'worker' ? [thread.owner.worker] : []),
      ...(thread.workers ?? []),
    ]))];
    // Projects that predate automatic naming, and any whose naming call
    // failed, get a name the first time their panel asks for state. Guarded
    // against repeats inside; this route is refetched on every worker event.
    void backfillProjectName(conversationId, state.outcome);
    res.json({ ...state, unread: Object.fromEntries(unreadInboxSummaries(carrying, conversationId)) } satisfies ProjectStateResponse);
  }));

  // Splitting a project: move a worker, or an open thread with its workers,
  // to another coordinator. `lattice session move-worker` / `move-thread`
  // are the clients; see services/sessions/project-move.ts.
  const sendMoveError = (res: Response, err: unknown): void => {
    if (err instanceof ProjectMoveError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  };
  router.post('/:conversationId/move', asyncHandler(async (req: RequestWithRequestId, res) => {
    const body = (req.body ?? {}) as { from?: unknown; to?: unknown; thread?: unknown };
    if (typeof body.from !== 'string' || typeof body.to !== 'string') {
      res.status(400).json({ error: 'from and to name the two coordinators' });
      return;
    }
    if (body.thread !== undefined && typeof body.thread !== 'number') {
      res.status(400).json({ error: 'thread must be a thread seq in the new project' });
      return;
    }
    try {
      res.json(await moveWorker({ worker: req.params.conversationId, from: body.from, to: body.to, thread: body.thread as number | undefined }));
    } catch (err) {
      sendMoveError(res, err);
    }
  }));
  router.post('/:conversationId/project/threads/:thread/move', asyncHandler(async (req: RequestWithRequestId, res) => {
    const body = (req.body ?? {}) as { to?: unknown };
    const thread = Number(req.params.thread);
    if (typeof body.to !== 'string' || !Number.isInteger(thread)) {
      res.status(400).json({ error: 'to names the coordinator, and the path the thread seq' });
      return;
    }
    try {
      res.json(await moveThread({ from: req.params.conversationId, to: body.to, thread }));
    } catch (err) {
      sendMoveError(res, err);
    }
  }));

  router.post('/:conversationId/project/note', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { conversationId } = req.params;
    const conversation = conversationService.getConversation(conversationId);
    if (!conversationId.startsWith('conv-') || !conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    if (!conversation.coordinator) {
      res.status(400).json({ error: 'Not a coordinator conversation' });
      return;
    }
    // `addresses` arrives wider than it is stored: a caller may name a
    // worker instead of its event seqs, and this resolves that first.
    const body = (req.body ?? {}) as Omit<Partial<ProjectNotedData>, 'addresses' | 'supersedes' | 'evidence'>
      & { addresses?: unknown; disposition?: unknown; supersedes?: unknown; evidence?: unknown };

    const kind = body.kind;
    if (!kind || !(PROJECT_NOTE_KINDS as readonly string[]).includes(kind)) {
      res.status(400).json({ error: `kind must be one of ${PROJECT_NOTE_KINDS.join(', ')}` });
      return;
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    // `close` records how it was resolved and `update` may only change the
    // structured half, so neither needs text; everything else is the note.
    if (!text && kind !== 'close' && kind !== 'update') {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    if (kind === 'outcome' && typeof body.name === 'string' && body.name.trim() && !normalizeProjectName(body.name)) {
      res.status(400).json({ error: 'a project name is a short noun phrase for the thing being owned, not the work being done to it: "Lattice workspace improvements", not "Simplify the sidebar"' });
      return;
    }

    const state = readProjectState(conversationId);

    // A decision stops binding only when a later note names it by seq. The
    // seq has to be a decision this project actually took and not one already
    // out of force, so a correction cannot silently reach nothing.
    let supersedes: number[] | undefined;
    if (kind === 'decision' || kind === 'retire') {
      // A retirement that names nothing would be a note that withdraws
      // nothing while reading as though it had.
      if (kind === 'retire' && (!Array.isArray(body.supersedes) || body.supersedes.length === 0)) {
        res.status(400).json({ error: 'retire names the decision seqs it withdraws' });
        return;
      }

      if (body.supersedes !== undefined) {
        if (!Array.isArray(body.supersedes)) {
          res.status(400).json({ error: 'supersedes must be an array of decision seqs' });
          return;
        }
        const active = new Set(state.decisions.map((decision) => decision.seq));
        const unknown = (body.supersedes as unknown[]).filter((entry) => typeof entry !== 'number' || !active.has(entry));
        if (unknown.length > 0) {
          const retired = state.retired.filter((decision) => unknown.includes(decision.seq));
          res.status(400).json({
            error: `not a decision in force on this project: ${unknown.join(', ')}`
              + (retired.length > 0
                ? `. ${retired.map((decision) => decision.seq).join(', ')} already stopped binding at [${retired.map((decision) => decision.retiredBy).join(', ')}].`
                : `. In force: ${[...active].join(', ') || 'none'}`),
          });
          return;
        }
        supersedes = [...new Set(body.supersedes as number[])].sort((a, b) => a - b);
      }
    }

    // A priority may name the open thread it concerns, and only an open one:
    // the point of binding it is that closing that thread clears it.
    if (kind === 'priority' && body.ref !== undefined) {
      if (!state.open.some((candidate) => candidate.seq === body.ref)) {
        res.status(400).json({ error: `a priority names an open thread: ${state.open.map((t) => t.seq).join(', ') || 'none open'}` });
        return;
      }
    }

    if (kind === 'retire' || kind === 'priority') {
      const seq = appendProjectNote(conversationId, {
        kind, text, by: body.by === 'user' ? 'user' : 'coordinator',
        ...(supersedes ? { supersedes } : {}),
        ...(kind === 'priority' && typeof body.ref === 'number' ? { ref: body.ref } : {}),
      });
      if (seq === null) {
        res.status(503).json({ error: 'Note not recorded' });
        return;
      }
      res.json({ seq, state: readProjectState(conversationId) });
      return;
    }

    // Starting accounting is a one-off: the boundary is what separates

    // reports this coordinator is answerable for from reports written before
    // anything recorded a disposition, and moving it would unaccount work.
    if (kind === 'accounting' && state.accountingFrom !== null) {
      res.status(400).json({ error: `accounting already started at [${state.accountingFrom}]; it is a boundary, not a setting` });
      return;
    }

    // Reconciling is how a pre-boundary report gets a disposition, one seq at
    // a time with the evidence. It reaches nothing else: a report written
    // since the boundary is ordinary pending attention and goes through
    // --addresses on the thread it belongs to.
    if (kind === 'reconcile') {
      if (!(RECONCILE_DISPOSITIONS as readonly string[]).includes(body.disposition as string)) {
        res.status(400).json({ error: `disposition must be one of ${RECONCILE_DISPOSITIONS.join(', ')}` });
        return;
      }
      if (!Array.isArray(body.addresses) || body.addresses.length === 0) {
        res.status(400).json({ error: 'reconcile names the exact event seqs it accounts for; there is no blanket clear' });
        return;
      }
      const unknown = (body.addresses as unknown[]).filter((entry) => !state.historical.some((item) => item.seq === entry));
      if (unknown.length > 0) {
        res.status(400).json({
          error: `not unreconciled history on this coordinator: ${unknown.join(', ')}`
            + (state.attention.some((item) => unknown.includes(item.seq))
              ? '. That event is waiting on a disposition now — account for it on its thread with addresses instead.'
              : `. Unreconciled: ${state.historical.map((item) => item.seq).join(', ') || 'none'}`),
        });
        return;
      }
      if (body.ref !== undefined && ![...state.open, ...state.closed].some((candidate) => candidate.seq === body.ref)) {
        res.status(400).json({ error: `ref must be a thread of this project, open or closed: ${[...state.open, ...state.closed].map((t) => t.seq).join(', ') || 'none'}` });
        return;
      }
      const seqs = [...new Set(body.addresses as number[])].sort((a, b) => a - b);
      const seq = appendProjectNote(conversationId, {
        kind, text, by: body.by === 'user' ? 'user' : 'coordinator',
        disposition: body.disposition as ReconcileDisposition,
        addresses: seqs,
        ...(typeof body.ref === 'number' ? { ref: body.ref } : {}),
      });
      if (seq === null) {
        res.status(409).json({ error: 'Could not append the note' });
        return;
      }
      res.json({ seq, state: readProjectState(conversationId) });
      return;
    }
    // A thread is identified by the seq of the `open` note that created it,
    // for its whole life: an update keeps that id rather than writing a new
    // thread, so a worker, a report and a closure all name the same one.
    let thread: ProjectOpenThread | undefined;
    if (kind === 'update' || kind === 'close') {
      thread = state.open.find((candidate) => candidate.seq === body.ref);
      if (typeof body.ref !== 'number' || !thread) {
        res.status(400).json({ error: `ref must be an open thread: ${state.open.map((t) => t.seq).join(', ') || 'none open'}` });
        return;
      }
    }

    let owner: ThreadOwner | undefined;
    if (body.owner !== undefined) {
      const parsed = parseOwner(body.owner);
      if (!parsed) {
        res.status(400).json({ error: 'owner must be {kind:"coordinator"|"user"} or {kind:"worker",worker} or {kind:"external",who}' });
        return;
      }
      owner = parsed;
    }

    let waitingOn: ThreadWait | null | undefined;
    if ('waitingOn' in body) {
      if (body.waitingOn === null) {
        waitingOn = null;
      } else {
        const parsed = parseWait(body.waitingOn);
        if (!parsed) {
          res.status(400).json({ error: `waitingOn must be null or {kind, text} with kind one of ${THREAD_WAIT_KINDS.join(', ')}` });
          return;
        }
        waitingOn = parsed;
      }
    }

    const workers = Array.isArray(body.workers)
      ? body.workers.filter((worker): worker is string => typeof worker === 'string' && worker.length > 0)
      : undefined;
    for (const worker of workers ?? []) {
      if (!conversationService.getConversation(worker)) {
        res.status(400).json({ error: `no such conversation: ${worker}` });
        return;
      }
    }

    // `--addresses` names the worker events this transition accounts for. A
    // worker id stands for that worker's pending events *on this thread*:
    // a worker reused on a later thread must not have its other reports
    // discharged by a closure that never looked at them.
    let addresses: number[] | undefined;
    if (body.addresses !== undefined) {
      if (!Array.isArray(body.addresses)) {
        res.status(400).json({ error: 'addresses must be an array of event seqs or worker conversation ids' });
        return;
      }
      const resolved = new Set<number>();
      for (const entry of body.addresses as unknown[]) {
        if (typeof entry === 'number') {
          const pending = state.attention.find((item) => item.seq === entry);
          if (!pending) {
            res.status(400).json({ error: `event ${entry} is not waiting on a disposition: ${state.attention.map((item) => item.seq).join(', ') || 'nothing is'}` });
            return;
          }
          resolved.add(entry);
          continue;
        }
        if (typeof entry !== 'string') {
          res.status(400).json({ error: 'addresses must be an array of event seqs or worker conversation ids' });
          return;
        }
        const scoped = state.attention.filter((item) => item.worker === entry && (thread ? item.thread === thread.seq : true));
        if (scoped.length === 0) {
          res.status(400).json({
            error: thread
              ? `${entry} has nothing waiting on thread [${thread.seq}]; name the event seqs instead if they belong to another thread`
              : `${entry} has nothing waiting on a disposition`,
          });
          return;
        }
        for (const item of scoped) resolved.add(item.seq);
      }
      addresses = [...resolved].sort((a, b) => a - b);
    }

    if (kind === 'update' && !text && owner === undefined && waitingOn === undefined
      && body.nextAction === undefined && !workers?.length && !addresses?.length
      && !(Array.isArray(body.evidence) && body.evidence.length > 0)) {
      res.status(400).json({ error: 'an update must change something: a summary, evidence, owner, next action, what it waits on, a worker, or the events it accounts for' });
      return;
    }


    const evidence = Array.isArray(body.evidence)
      ? (body.evidence as unknown[]).filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : undefined;

    const data: ProjectNotedData = {
      kind,
      text,
      by: body.by === 'user' ? 'user' : 'coordinator',
      ...(kind === 'outcome' && typeof body.name === 'string' && body.name.trim() ? { name: body.name.trim() } : {}),
      ...(kind === 'update' || kind === 'close' ? { ref: body.ref } : {}),
      ...(owner ? { owner } : {}),
      ...(typeof body.nextAction === 'string' && body.nextAction.trim() ? { nextAction: body.nextAction.trim() } : {}),
      ...(waitingOn !== undefined ? { waitingOn } : {}),
      ...(workers?.length ? { workers } : {}),
      ...(addresses?.length ? { addresses } : {}),
      ...(evidence?.length ? { evidence } : {}),
      ...(supersedes ? { supersedes } : {}),
    };

    const seq = appendProjectNote(conversationId, data);
    if (seq === null) {
      res.status(503).json({ error: 'Note not recorded' });
      return;
    }
    // Dealing with a report or closing a thread is what finishes a worker, so
    // this is when the finished ones are archived. See worker-auto-archive.ts.
    const archivedWorkers = archiveFinishedWorkers(conversationId);
    res.json({ seq, state: readProjectState(conversationId), archivedWorkers });
  }));

  // ==========================================================================
  // GET /:conversationId/status — Get streaming status for a unified conversation
  // ==========================================================================
  router.get('/:conversationId/status', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { conversationId } = req.params;

    if (!conversationId.startsWith('conv-')) {
      res.status(404).json({ error: 'Not a unified conversation ID' });
      return;
    }

    let conversation = conversationService.getConversation(conversationId);
    if (!conversation) {
      throw new LatticeError('CONVERSATION_NOT_FOUND', `Conversation ${conversationId} not found`, 404);
    }

    // Find active segment using runtime process status.
    const activeSegment = findRuntimeActiveSegment(conversation);
    let status: 'completed' | 'ongoing' | 'pending' = 'completed';
    let streamingId: string | null = null;
    let startedAt: string | null = null;
    let provider: Provider | null = null;

    if (activeSegment) {
      const registryEntry = activeConversationRegistry.get(conversationId);
      status = 'ongoing';
      provider = registryEntry?.segment.provider ?? activeSegment.provider;
      streamingId = registryEntry?.run?.streamingId ?? activeSegment.streamingId ?? null;
      startedAt = registryEntry?.run?.startedAt ?? activeSegment.createdAt;
    }

    res.json({
      sessionId: conversationId,
      status,
      provider,
      streamingId,
      startedAt,
    });
  }));

  // ==========================================================================
  // GET /:conversationId — Get conversation details (ConversationDetailsResponse)
  // ==========================================================================

  // Core detail-fetching logic, extracted so the outer handler can coalesce.
  async function fetchConversationDetails(
    conversationId: string,
    pageLimit: number | undefined,
    beforeCursor: string | undefined,
    traceId: string | undefined,
    assertConnected: () => void,
  ): Promise<ConversationDetailsResponse> {
    const requestStart = Date.now();
    const phases: Record<string, number> = {};
    let phaseStart = requestStart;
    const mark = (name: string): void => { const now = Date.now(); phases[name] = now - phaseStart; phaseStart = now; };

    let conversation = conversationService.getConversation(conversationId);
    if (!conversation) {
      throw new LatticeError('CONVERSATION_NOT_FOUND', `Conversation ${conversationId} not found`, 404);
    }

    if (traceId) {
      logger.debug('[CONV] Details request', {
        traceId,
        conversationId,
        limit: pageLimit ?? null,
        before: beforeCursor ?? null,
      });
    }

    mark('sync_setup');

    const latestSegment = getLatestSegmentForFallback(conversation);
    // Only branch metadata is read here, so keep the identity_image blob out
    // of the projection entirely.
    const detailInfo = sessionInfoService.getSessionInfoBatch(
      [conversationId, ...(latestSegment ? [latestSegment.providerSessionId] : [])],
      { includeIdentityImage: false },
    );
    const convInfo = detailInfo.get(conversationId) ?? null;
    const segmentInfo = latestSegment
      ? detailInfo.get(latestSegment.providerSessionId) ?? null
      : null;
    const branchedFromSessionId = convInfo?.branched_from_session_id
      || segmentInfo?.branched_from_session_id
      || null;
    const branchedAtTurn = convInfo?.branched_at_turn
      ?? segmentInfo?.branched_at_turn
      ?? null;
    const _requiresResolverForBranchHistory = Boolean(branchedFromSessionId);

    mark('session_info');

    // Read messages from harness event storage (canonical source).
    //
    // Hot path is a bounded tail read: every UI caller passes ?limit, and
    // reconstructing a whole history here was one of the main-thread stalls
    // in the 2026-08-07 freeze investigation. The full read remains only for
    // cursor requests (no UI caller sends `before` today), unpaged requests,
    // and conversations with codex segments — provider attribution needs
    // run:start events that a tail window can miss.
    const shouldPage = pageLimit !== undefined || beforeCursor !== undefined;
    const hasCodexSegment = conversation.segments.some((segment) => segment.provider === 'codex');
    const canServeFromTail = pageLimit !== undefined && beforeCursor === undefined && !hasCodexSegment;

    let responseMessages: ConversationMessage[] = [];
    let hasMore = false;
    let oldestMessageId: string | undefined;
    let totalMessages = 0;
    const duplicateMessagesDropped = 0;

    mark('store_key_check');

    if (canServeFromTail) {
      const tail = readMessagesTail(conversationId, pageLimit || DEFAULT_DETAILS_PAGE_SIZE);
      responseMessages = tail.messages.map((message) =>
        mapUnifiedMessageToConversationMessage(message, conversationId)
      );
      hasMore = tail.hasMore;
      oldestMessageId = responseMessages[0]?.uuid;
      // On partial serves the exact message total is unknown without a full
      // read; the stored event count is an upper bound. Only client telemetry
      // reads this field.
      totalMessages = tail.hasMore ? countMessages(conversationId) : responseMessages.length;
    } else {
      // harness_events is the only message source. Pre-cutover conversations are
      // migrated into it at startup by migrateLegacyMessagesToEvents(), so an
      // empty read here means the conversation genuinely has no history.
      const unifiedMessages = readMessages(conversationId);
      if (unifiedMessages.length > 0) {
        const allMessages = unifiedMessages.map((message) =>
          mapUnifiedMessageToConversationMessage(message, conversationId)
        );
        totalMessages = allMessages.length;

        if (shouldPage) {
          const paginated = paginateConversationMessages(allMessages, pageLimit, beforeCursor);
          responseMessages = paginated.messages;
          hasMore = paginated.hasMore;
          oldestMessageId = paginated.oldestMessageId;
        } else {
          responseMessages = allMessages;
        }
      }
    }

    mark('message_load');

    // Resize images to thumbnails for browser display (full-res stays in JSONL).
    await thumbnailImageBlocks(responseMessages);
    assertConnected();

    mark('thumbnail');

    // Determine status from runtime-active segments.
    const activeSegment = findRuntimeActiveSegment(conversation);
    const status: 'ongoing' | 'completed' = activeSegment ? 'ongoing' : 'completed';
    const activeStreamingId = activeSegment?.streamingId || undefined;

    mark('status_resolve');

    const mergedSessionInfo = sessionInfoService.getMergedSessionInfo(
      conversationId,
      latestSegment?.providerSessionId,
    ) || {
      custom_name: '',
      pinned: false,
      archived: false,
      continuation_session_id: '',
      initial_commit_head: '',
      permission_mode: 'default',
      workspace: conversation.workspace,
      created_at: conversation.createdAt,
      updated_at: conversation.updatedAt,
      version: 4,
      conversation_id: conversationId,
    };
    let branchPointMessageId: string | undefined;
    if (branchedAtTurn && branchedAtTurn > 0) {
      try {
        const providerSessionId = sessionInfoService.resolveToProviderSessionId(conversationId);
        if (providerSessionId) {
          const branchService = SessionBranchService.getInstance();
          branchPointMessageId = await branchService.getBranchPointMessageId(providerSessionId, branchedAtTurn) || undefined;
        }
      } catch (error) {
        logger.debug('[CONV] Failed to resolve branch point message ID', {
          conversationId,
          branchedAtTurn,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    mark('branch_resolve');

    // Load MCP servers — check conv-* first, then provider session, then ~/.claude.json fallback
    const mcpServers = sessionInfoService.getMcpServers(conversationId)
      || (latestSegment ? sessionInfoService.getMcpServers(latestSegment.providerSessionId) : null)
      || sessionInfoService.getConfiguredMcpServersFallback()
      || undefined;

    const response: ConversationDetailsResponse = {
      sessionId: conversationId,
      messages: responseMessages,
      summary: '',
      projectPath: conversation.workingDirectory,
      metadata: {
        totalDuration: 0,
        model: latestSegment?.model || 'unknown',
      },
      // The effort a Codex conversation is actually running at, so the
      // composer can show the choice rather than its own default. Absent for
      // other providers and for conversations from before the column.
      ...(latestSegment?.reasoningEffort ? { reasoningEffort: latestSegment.reasoningEffort } : {}),
      status,
      streamingId: activeStreamingId,
      sessionInfo: mergedSessionInfo,
      totalMessages,
      hasMore,
      oldestMessageId,
      deduplication: {
        storesMerged: 1,
        duplicateMessagesDropped,
        uniqueMessages: totalMessages,
      },
      mcpServers,
      branchPointMessageId,
      coordinator: conversation.coordinator,
      pickedUpFrom: conversation.pickedUpFrom,
    };

    mark('response_build');

    const durationMs = Date.now() - requestStart;
    if (durationMs > 500) {
      logger.warn('[CONV] Slow details response', {
        traceId,
        conversationId,
        durationMs,
        phases,
        storeKeys: 1,
        returnedMessages: responseMessages.length,
        totalMessages,
        paginated: shouldPage,
        duplicateMessagesDropped,
      });
    } else if (traceId) {
      logger.debug('[CONV] Details response', {
        traceId,
        conversationId,
        durationMs,
        returnedMessages: responseMessages.length,
        totalMessages,
        hasMore,
        duplicateMessagesDropped,
      });
    }

    return response;
  }

  router.get('/:conversationId(conv-[^/]+)', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { conversationId } = req.params;
    const limitParam = toPositiveBoundedInt(req.query.limit, 0, MAX_DETAILS_PAGE_SIZE);
    const pageLimit = limitParam > 0 ? limitParam : undefined;
    const beforeCursor = typeof req.query.before === 'string' && req.query.before.trim().length > 0
      ? req.query.before
      : undefined;
    const traceId = typeof req.headers['x-trace-id'] === 'string'
      ? req.headers['x-trace-id']
      : undefined;

    // Only handle conv-* IDs — let other IDs fall through to legacy routes
    if (!conversationId.startsWith('conv-')) {
      res.status(404).json({ error: 'Not a unified conversation ID' });
      return;
    }

    // Fix 1: Abort early if the client has already disconnected.
    const assertConnected = (): void => {
      if (req.socket?.destroyed || res.destroyed) {
        throw new ClientDisconnectedError();
      }
    };

    // Fix 3: Request coalescing — concurrent identical requests share one execution.
    const coalesceKey = `${conversationId}:${pageLimit ?? ''}:${beforeCursor ?? ''}`;
    const inflight = inflightDetails.get(coalesceKey);
    if (inflight) {
      logger.debug('[CONV] Coalescing detail request', { conversationId, coalesceKey });
      try {
        const response = await inflight;
        assertConnected();
        res.json(response);
      } catch (error) {
        if (error instanceof ClientDisconnectedError) return;
        throw error;
      }
      return;
    }

    const detailPromise = fetchConversationDetails(
      conversationId, pageLimit, beforeCursor, traceId, assertConnected,
    );
    inflightDetails.set(coalesceKey, detailPromise);

    try {
      const response = await detailPromise;
      assertConnected();
      res.json(response);
    } catch (error) {
      if (error instanceof ClientDisconnectedError) {
        logger.debug('[CONV] Aborted detail request (client disconnected)', { conversationId });
        return;
      }
      throw error;
    } finally {
      inflightDetails.delete(coalesceKey);
    }
  }));

}
