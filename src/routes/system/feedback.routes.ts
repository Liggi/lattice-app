import { Router, type NextFunction, type Request, type Response } from 'express';
import { asyncHandler } from '@/middleware/error-handler.js';
import { isFromLatticePage, requireTrustedOrigin } from '@/middleware/trusted-origin.js';
import type { ConfigService } from '@/services/infrastructure/config-service.js';
import { ConversationService } from '@/services/sessions/conversation-service.js';
import { collectorOriginOf, FeedbackError, FeedbackService } from '@/services/feedback/feedback-service.js';
import { FeedbackInbox } from '@/services/feedback/feedback-inbox.js';
import { getHarnessSessionManager } from '@/harness/setup.js';
import { appendCustomHarnessEvent } from '@/harness/harness-custom-events.js';
import { readWorkerStates } from '@/services/sessions/worker-events.js';
import { createLogger } from '@/services/infrastructure/logger.js';
import { FEEDBACK_PROPOSED_EVENT, type FeedbackDraftView, type FeedbackInboxView, type FeedbackProposedData } from '@/types/feedback.js';

const logger = createLogger('FeedbackRoutes');

function conversationLookup(conversationId: string): { provider: string | null; model: string | null } | null {
  const conversation = ConversationService.getInstance().getConversation(conversationId);
  if (!conversation) return null;
  return { provider: conversation.latestProvider, model: conversation.segments.at(-1)?.model ?? null };
}

/**
 * Puts an agent's proposal in the chat the user reads: the session's own, or
 * for a worker its coordinator's, where it is dispatched from. Written into
 * the event log as a UI-only item; no agent reads it.
 */
function postProposalCard(draft: FeedbackDraftView): void {
  const from = draft.conversationId;
  if (!from) return;
  const manager = getHarnessSessionManager();
  if (!manager) return;
  const coordinator = ConversationService.getInstance().getConversation(from)?.pickedUpFrom ?? null;
  const workerTitle = coordinator
    ? readWorkerStates(coordinator).find((worker) => worker.worker === from)?.task ?? null
    : null;
  const data: FeedbackProposedData = { draftId: draft.id, from, workerTitle };
  if (!appendCustomHarnessEvent(manager, coordinator ?? from, FEEDBACK_PROPOSED_EVENT, data)) {
    logger.warn('Feedback proposal card not written; it is still listed in Settings', { draftId: draft.id, from });
  }
}

function requireBrowserPage(req: Request, _res: Response, next: NextFunction): void {
  if (isFromLatticePage(req.headers)) {
    next();
    return;
  }
  next(new FeedbackError('Feedback is sent from the Lattice page, by the user. Nothing was sent.', 403, 'browser_only'));
}

/** FeedbackErrors carry the status and a sentence the page and CLI show as-is. */
function feedbackErrors(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (err instanceof FeedbackError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  next(err);
}

/**
 * Feedback drafts, sending them to the collector, and (on a Lattice with a
 * read-token file) the inbox. Every route is same-origin only: the global CORS
 * policy reflects any origin, and both the drafts and the inbox are private.
 */
export function createFeedbackRoutes(configService: ConfigService): Router {
  const router = Router();
  const inbox = new FeedbackInbox();
  const service = new FeedbackService(
    () => configService.getConfig().feedback,
    conversationLookup,
    () => inbox.available(),
    undefined,
    undefined,
    postProposalCard,
  );

  router.use(requireTrustedOrigin);

  router.get('/status', (_req, res) => {
    res.json(service.status());
  });

  // Turning feedback on or off, and a fork's own collector. Its own route
  // because the config route replaces unknown sections wholesale.
  router.put('/settings', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { enabled?: unknown; collectorUrl?: unknown };
    const next = { ...(configService.getConfig().feedback ?? {}) };
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw new FeedbackError('enabled must be true or false.', 400, 'invalid_request');
      next.enabled = body.enabled;
    }
    if (body.collectorUrl !== undefined) {
      if (body.collectorUrl === null || body.collectorUrl === '') {
        delete next.collectorUrl;
      } else if (typeof body.collectorUrl === 'string') {
        const origin = collectorOriginOf(body.collectorUrl.trim());
        if ('problem' in origin) throw new FeedbackError(origin.problem, 400, 'collector_url_invalid');
        next.collectorUrl = origin.origin;
      } else {
        throw new FeedbackError('collectorUrl must be a URL or null.', 400, 'invalid_request');
      }
    }
    await configService.updateConfig({ feedback: next });
    res.json(service.status());
  }));

  // The one-time check: the page frames the collector's panel for this
  // install, and hands the ticket here to be traded for the install's key.
  router.get('/registration', (_req, res) => {
    res.json(service.registration());
  });

  router.post('/register', requireBrowserPage, asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { ticket?: unknown };
    await service.register(body.ticket);
    await configService.updateConfig({ feedback: { ...(configService.getConfig().feedback ?? {}), enabled: true } });
    res.json(service.status());
  }));

  router.get('/proposals/:id', (req, res) => {
    res.json(service.proposal(req.params.id));
  });

  router.get('/context', (req, res) => {
    const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : null;
    res.json(service.context(conversationId));
  });

  router.get('/drafts', (_req, res) => {
    res.json({ drafts: service.listDrafts() });
  });

  router.get('/drafts/:id', (req, res) => {
    res.json(service.getDraft(req.params.id));
  });

  router.post('/drafts', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const draft = service.createDraft({
      source: body.source === 'agent' ? 'agent' : 'human',
      category: typeof body.category === 'string' ? body.category : undefined,
      message: body.message as string,
      conversationId: typeof body.conversationId === 'string' ? body.conversationId : null,
      screen: typeof body.screen === 'string' ? body.screen : undefined,
    });
    res.status(201).json(draft);
  });

  router.put('/drafts/:id', (req, res) => {
    const body = (req.body ?? {}) as { category?: string; message?: string };
    res.json(service.updateDraft(req.params.id, { category: body.category, message: body.message }));
  });

  router.delete('/drafts/:id', (req, res) => {
    service.deleteDraft(req.params.id);
    res.json({ deleted: true });
  });

  router.post('/drafts/:id/send', requireBrowserPage, asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { revision?: unknown };
    res.json(await service.send(req.params.id, body.revision));
  }));

  router.get('/inbox', asyncHandler(async (req, res) => {
    const view = req.query.view === 'all' || req.query.view === 'flagged' ? req.query.view : 'unread';
    res.json(await inbox.list(view as FeedbackInboxView));
  }));

  router.post('/inbox/refresh', asyncHandler(async (_req, res) => {
    await inbox.refresh(true);
    res.json({ ok: true });
  }));

  router.get('/inbox/unread-count', asyncHandler(async (_req, res) => {
    res.json({ unread: await inbox.unreadCount() });
  }));

  router.patch('/inbox/:id', (req, res) => {
    const body = (req.body ?? {}) as { read?: unknown; done?: unknown };
    inbox.mark(req.params.id, body);
    res.json({ ok: true });
  });

  router.use(feedbackErrors);
  return router;
}
