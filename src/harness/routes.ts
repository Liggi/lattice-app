import type { Provider } from '@/types/unified-messages.js';
/**
 * Harness routes — minimal REST + SSE surface for session lifecycle.
 *
 * POST /api/harness/:sessionId/start   → start a session
 * POST /api/harness/:sessionId/send    → send user input
 * POST /api/harness/:sessionId/reactions → add or remove the user's emoji reaction on a message
 * POST /api/harness/:sessionId/compact → compact provider context
 * POST /api/harness/:sessionId/stop    → stop the session
 * GET  /api/harness/:sessionId/events  → SSE event stream (real-time + current turn replay)
 * GET  /api/harness/:sessionId/history → paginated event history (scroll-up)
 * GET  /api/harness/:sessionId/status  → current status snapshot
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { SessionManager, createSSEHandler } from '@liggi/agent-ui-harness/server';
import { createLogger } from '../services/infrastructure/logger.js';
import { CODEX_MODELS, DEFAULT_CODEX_MODEL_ID } from '../constants/codex-models.js';
import { CLAUDE_MODELS } from '../constants/claude-models.js';
import { supersededModelRefusal } from '../constants/superseded-models.js';
import { unfinishedSwitchRefusal } from '../services/sessions/coordinator-switch-state.js';
import { currentResumeModel } from '../services/sessions/resume-model.js';
import { currentCodexReasoningEffort, knownCodexReasoningEffort } from '../services/sessions/codex-effort.js';
import { parseAttachmentBlocks } from './attachment-blocks.js';
import { ConversationService } from '../services/sessions/conversation-service.js';
import { appendWorkerEvent, currentWorkerTask, isWorkerQuestionSeq, openQuestion } from '../services/sessions/worker-events.js';
import { reopenArchivedWorker } from '../session-history/repository.js';
import { buildCoordinatorRestore } from '../services/sessions/context-compaction.js';
import { buildProjectOrientation } from '../services/sessions/project-orientation.js';
import { buildWorkerDriftNote } from '../services/sessions/worker-drift.js';

import { buildProjectStateNudge, buildStaleProjectLine } from '../services/sessions/project-state.js';
import { latticeCli } from '../services/sessions/pickup-prompts.js';
import {
  drainHeld,
  drainInbox,
  enqueueInboxItem,
  hasUnreadInboxItems,
  type DrainResult,
} from '../services/sessions/session-inbox.js';
import { admitTurn, isAdmissionToken, type TurnAdmission } from '../services/sessions/turn-admission.js';
import { interruptTurn } from '../services/sessions/turn-interrupt.js';
import { noteUserStoppedWorker } from '../services/sessions/worker-report-delivery.js';
import {
  deliverIntoRunningTurn,
  immediateDeliveryEnabled,
  type ImmediateDeliveryResult,
} from '../services/sessions/immediate-delivery.js';
import { agentReact, reactToMessage } from '../services/sessions/message-reactions.js';
import { answerDecision, askDecision, DecisionError } from '../services/sessions/decisions.js';
import { isFromLatticePage } from '../middleware/trusted-origin.js';
import { isSingleEmoji } from '../types/message-reactions.js';
import { INBOX_READ_EVENT, INBOX_UNDELIVERABLE_EVENT, type InboxReadData, type InboxUndeliverableData } from '../types/inbox.js';
import { persistCoordinatorImages } from '../services/sessions/coordinator-attachments.js';
import { appendCustomHarnessEvent } from './harness-custom-events.js';
import { noteUserSent } from '../services/sessions/project-needs-you.js';
import type { WorkerAnsweredData, WorkerReassignedData } from '../types/worker-events.js';

const logger = createLogger('HarnessRoutes');

/** Wrap async route handlers to forward rejections to Express error handling. */
function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

export interface HarnessRouteResolvers {
  /** Resolve a conversationId (conv-*) to the JSONL provider session ID for --resume. */
  resolveResumeSessionId: (conversationId: string) => string;
  /** Resolve a conversationId to the latest provider. */
  resolveProvider: (conversationId: string) => Provider;
  /** Resolve a conversationId to its working directory. */
  resolveWorkingDirectory: (conversationId: string) => string | undefined;
  /** State of the provider transcript --resume needs. 'unknown' means we could
   *  not tell — never treat that as missing, or a machine whose transcripts we
   *  cannot see would have every resume refused. */
  classifyResumeTranscript?: (providerSessionId: string) => Promise<'present' | 'missing' | 'unknown'>;
  /** How long `--interrupt` waits for the cancelled turn to end; tests shorten it. */
  interruptWaitMs?: number;
  /** Seed runtime registries for direct harness starts. Lifecycle routes may
   *  register first; this callback should be idempotent for already-registered
   *  conversations. */
  onSessionStarted?: (info: {
    sessionId: string;
    provider: Provider;
    processId?: string;
    model?: string;
    permissionMode?: string;
  }) => void;
}

/**
 * Claude keeps resume state in its own transcript and prunes it after
 * cleanupPeriodDays. Resuming a pruned session makes the CLI print "No
 * conversation found with session ID: …" and exit 1 within a second, and that
 * arrives as an ordinary finished turn — so the conversation sits idle with no
 * explanation. Refuse up front rather than spawn a process that cannot succeed.
 *
 * Returns true when it has already answered the request.
 */
async function refuseIfTranscriptPruned(
  res: Response,
  resolvers: HarnessRouteResolvers,
  sessionId: string,
  provider: Provider,
  resumeId: string | null | undefined,
): Promise<boolean> {
  // Codex resumes by thread ID, and `resumeId === sessionId` means there is
  // nothing to resume.
  if (provider !== 'claude') return false;
  if (!resumeId || resumeId === sessionId) return false;
  if (!resolvers.classifyResumeTranscript) return false;

  // Only refuse on a positive 'missing'. Fail open otherwise — a false refusal
  // breaks every conversation, which is far worse than the silent idle this
  // guard exists to prevent.
  if (await resolvers.classifyResumeTranscript(resumeId) !== 'missing') return false;

  logger.warn('Refusing resume — provider transcript is no longer on disk', {
    sessionId: sessionId.slice(0, 12),
    providerSessionId: resumeId.slice(0, 8),
  });
  res.status(409).json({
    error: "Claude Code has deleted this conversation's transcript, so it can't be continued. Its history is still readable here — start a new conversation to carry the work on.",
    code: 'RESUME_TRANSCRIPT_MISSING',
  });
  return true;
}

/**
 * What the send receipt says about when the process will read the input.
 * `now`: written to the process. `after-turn`: the process is mid-turn and
 * the message waits in the inbox for the turn to end. `saved`: the message
 * is in the inbox but did not reach the process when the receipt said it
 * would — the turn an interrupt cancelled did not end in time, or the drain
 * failed; `note` on the receipt says which, and the next turn boundary or
 * restart delivers it.
 */
export type SendDelivery = 'now' | 'after-turn' | 'saved';

/** A live process that is in a turn: anything written now waits for the turn to end. */
function isMidTurn(diagnostics: ReturnType<SessionManager['inspect']>): boolean {
  if (!diagnostics?.processAlive) return false;
  return diagnostics.status === 'streaming' || diagnostics.status === 'starting' || diagnostics.status === 'stopping';
}

/** The receipt for a message that is in the inbox, after a drain the route itself ran. */
function receiptForDrain(drained: DrainResult, inboxId: string, extra: Record<string, unknown>): Record<string, unknown> {
  switch (drained.outcome) {
    case 'delivered':
      return { ok: true, delivery: 'now' satisfies SendDelivery, inboxId, items: drained.items, ...(drained.readSeq !== null ? { readSeq: drained.readSeq } : {}), ...extra };
    case 'busy':
      return { ok: true, delivery: 'after-turn' satisfies SendDelivery, inboxId, ...extra };
    case 'nothing':
      // The row was read by another drain between the enqueue and this one: it reached the process.
      return { ok: true, delivery: 'now' satisfies SendDelivery, inboxId, ...extra };
    case 'failed':
      return {
        ok: true,
        delivery: 'saved' satisfies SendDelivery,
        inboxId,
        note: `Saved to the inbox but not delivered: ${drained.error}. It goes with the next turn boundary or server restart.`,
        ...extra,
      };
  }
}

/**
 * What the sender is told about a delivery into a running turn.
 *
 * The vocabulary is deliberately narrow. `now` means the provider
 * acknowledged this exact batch — that and no more; nothing here says the
 * model read it, understood it or acted on it, and the thread only says a
 * turn took it once the provider says a turn has. A refusal says
 * `after-turn`, because that is what actually happens next: the rows are in
 * the inbox and go at the turn boundary. An unacknowledged handover says
 * `saved` and says plainly that it is unresolved, because the honest answer
 * is that nobody knows.
 */
function receiptForImmediate(result: ImmediateDeliveryResult, inboxId: string): Record<string, unknown> {
  const base = {
    ok: true,
    inboxId,
    immediate: { status: result.status, reservationId: result.reservationId, items: result.items },
  };
  switch (result.status) {
    case 'delivered':
      return { ...base, delivery: 'now' satisfies SendDelivery, items: result.items };
    case 'rejected':
      return {
        ...base,
        delivery: 'after-turn' satisfies SendDelivery,
        note: `Not delivered into the running turn (${result.reason ?? 'refused'}). It is in the inbox and goes at the next turn boundary.`,
      };
    case 'uncertain':
      return {
        ...base,
        delivery: 'saved' satisfies SendDelivery,
        note: `Handed to the provider but not acknowledged (${result.reason ?? 'no acknowledgement'}). It is held so it cannot be sent twice, and needs a look.`,
      };
  }
}

export function createHarnessRoutes(sessionManager: SessionManager, resolvers: HarnessRouteResolvers): Router {
  const router = Router();
  const sseHandler = createSSEHandler(sessionManager);

  /**
   * Compact by spawning a fresh run against the persisted provider session,
   * for a conversation with no live process. Owns the response, including the
   * pruned-transcript refusal. Throws only when the spawn itself fails.
   */
  async function startColdCompact(res: Response, sessionId: string, provider: Provider): Promise<void> {
    const resumeId = resolvers.resolveResumeSessionId(sessionId);
    const resolvedCwd = resolvers.resolveWorkingDirectory(sessionId) ?? process.cwd();

    if (await refuseIfTranscriptPruned(res, resolvers, sessionId, provider, resumeId)) return;

    const effort = provider === 'codex' ? currentCodexReasoningEffort(sessionId) : null;
    const knownEffort = knownCodexReasoningEffort(effort);
    // A compaction is a process replacement, so it belongs on the model the
    // conversation is running at rather than on a default (resume-model.ts).
    const resumeModel = currentResumeModel(sessionId, provider);

    const runId = await sessionManager.start(sessionId, {
      prompt: '/compact',
      cwd: resolvedCwd,
      resume: resumeId !== sessionId ? resumeId : undefined,
      args: resumeModel ? [`--model=${resumeModel}`] : undefined,
      extra: {
        sessionId,
        provider,
        internalCommand: 'compact',
        inputSource: 'command',
        ...(provider === 'codex' ? {
          model: resumeModel ?? DEFAULT_CODEX_MODEL_ID,
          ...(knownEffort ? { reasoningEffort: knownEffort } : {}),
        } : {}),
      },
    });
    resolvers.onSessionStarted?.({
      sessionId,
      provider,
      processId: runId.processId,
    });
    logger.info('Compacting through a fresh run', {
      sessionId,
      model: resumeModel,
      modelSource: resumeModel ? 'segment' : 'provider-default',
      ...(effort ? { reasoningEffort: effort.effort, effortSource: effort.source } : {}),
    });
    res.json({ ok: true, recovered: true });
  }

  // Start a session
  router.post('/:sessionId/start', asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    // Blocked like a send: a start here would pick the provider an unfinished
    // coordinator switch left in doubt (coordinator-switch-state.ts).
    const unfinishedSwitch = unfinishedSwitchRefusal(sessionId, ConversationService.getInstance(), latticeCli());
    if (unfinishedSwitch) {
      res.status(409).json({ error: unfinishedSwitch });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const prompt = typeof body.prompt === 'string' ? body.prompt : undefined;
    const cwd = typeof body.cwd === 'string' ? body.cwd : undefined;
    const model = typeof body.model === 'string' ? body.model : undefined;
    const permissionMode = typeof body.permissionMode === 'string' ? body.permissionMode : undefined;
    const supersededStart = supersededModelRefusal(model);
    if (supersededStart) {
      res.status(400).json({ error: supersededStart });
      return;
    }
    const reasoningEffort = typeof body.reasoningEffort === 'string'
      ? body.reasoningEffort
      : undefined;

    // Composer attachments (base64 image/document/text blocks) for the first turn.
    const parsedAttachments = parseAttachmentBlocks(body.attachments);
    if (!parsedAttachments.ok) {
      res.status(400).json({ error: parsedAttachments.error });
      return;
    }
    const attachments = parsedAttachments.blocks;

    // A turn carrying only attachments and no typed text is legitimate — a bare
    // screenshot paste. Only a wholly empty body is a bad request.
    if (!prompt && attachments.length === 0) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    try {
      const args: string[] = [];
      if (permissionMode) args.push(`--permission-mode=${permissionMode}`);

      // Resolve the JSONL session ID and working directory from conversation metadata.
      // The sessionId in the URL is a conversationId (conv-*) — Claude CLI needs the
      // actual provider session ID for --resume.
      const resumeId = resolvers.resolveResumeSessionId(sessionId);
      const resolvedCwd = cwd ?? resolvers.resolveWorkingDirectory(sessionId) ?? process.cwd();
      const provider = resolvers.resolveProvider(sessionId);

      if (await refuseIfTranscriptPruned(res, resolvers, sessionId, provider, resumeId)) return;

      // A start against an existing conversation is a process replacement, so
      // the effort comes from what the conversation is running at, not from a
      // default (codex-effort.ts).
      const effort = provider === 'codex'
        ? currentCodexReasoningEffort(sessionId, reasoningEffort)
        : null;
      const knownEffort = knownCodexReasoningEffort(effort);
      // Symmetric with the effort: this request's model, else the one the
      // conversation is running at. Unshifted so the argument order is the
      // same one callers already see (resume-model.ts).
      const resumeModel = currentResumeModel(sessionId, provider, model);
      if (resumeModel) args.unshift(`--model=${resumeModel}`);

      const runId = await sessionManager.start(sessionId, {
        prompt: prompt ?? '',
        cwd: resolvedCwd,
        resume: resumeId !== sessionId ? resumeId : undefined,
        args,
        extra: {
          sessionId,
          provider,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(provider === 'codex' ? {
            model: resumeModel ?? DEFAULT_CODEX_MODEL_ID,
            ...(knownEffort ? { reasoningEffort: knownEffort } : {}),
          } : {}),
        },
      });
      resolvers.onSessionStarted?.({
        sessionId,
        provider,
        processId: runId.processId,
        model: resumeModel,
        permissionMode,
      });

      logger.info('Session started via harness', {
        sessionId,
        runId,
        resumeId: resumeId !== sessionId ? resumeId : undefined,
        attachments: attachments.length,
        model: resumeModel,
        modelSource: model ? 'request' : resumeModel ? 'segment' : 'provider-default',
        ...(effort ? { reasoningEffort: effort.effort, effortSource: effort.source } : {}),
      });
      res.json({ runId, sessionId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to start session', { sessionId, error: message });
      res.status(400).json({ error: message });
    }
  }));

  // Send user input
  router.post('/:sessionId/send', asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = typeof body.input === 'string' ? body.input : undefined;
    // Mid-session model switch: when present and different from the session's
    // current model, SessionManager.send() respawns with --resume instead of
    // writing to the live process.
    let model = typeof body.model === 'string' ? body.model : undefined;
    const reasoningEffort = typeof body.reasoningEffort === 'string'
      ? body.reasoningEffort
      : undefined;

    // Composer attachments. The harness client's send(input, extra) spreads
    // `extra` into this body, and SessionManager.send() threads the same object
    // through to ProcessHandle.write() — so this is per-message, never sticky.
    const parsedAttachments = parseAttachmentBlocks(body.attachments);
    if (!parsedAttachments.ok) {
      res.status(400).json({ error: parsedAttachments.error });
      return;
    }
    let attachments = parsedAttachments.blocks;

    if (!input && attachments.length === 0) {
      res.status(400).json({ error: 'input is required' });
      return;
    }

    // An inbox drain (session-inbox.ts) sending the session everything it had
    // waiting. The batch is already what the model should read, so it goes
    // straight to the process, and `input:read` is appended after the
    // `input:sent` it produces so the thread can pair the two.
    const inboxIds = Array.isArray(body.inboxIds) && body.inboxIds.every((id) => typeof id === 'string')
      ? body.inboxIds as string[]
      : undefined;
    // A superseded model on a send made now is refused, and nothing is saved.
    // On a queued batch it no longer applies, so the batch goes without it.
    const supersededSend = supersededModelRefusal(model);
    if (supersededSend) {
      if (!inboxIds) {
        res.status(400).json({ error: `Not sent: ${supersededSend}` });
        return;
      }
      logger.warn('Queued messages named a superseded model; sent without it', { sessionId, model });
      model = undefined;
    }

    // A coordinator can only pass text to a worker, so its images are also
    // kept on disk and the path travels with the message (see
    // coordinator-attachments.ts). A resend carries the already-augmented
    // blocks, so nothing is written twice.
    if (!inboxIds && attachments.length > 0
      && ConversationService.getInstance().getConversation(sessionId)?.coordinator) {
      attachments = persistCoordinatorImages(sessionId, attachments);
    }

    // `lattice session send --from <conv> [--summary "…"]`: when the sender is
    // the coordinator this session was picked up from, the coordinator's own
    // log records the message as a worker event (the quiet "answered the
    // worker" line in its thread). Any other sender is just a send.
    const from = typeof body.from === 'string' ? body.from : undefined;
    const summary = typeof body.summary === 'string' && body.summary.trim() ? body.summary.trim() : null;
    // `--passed-on`: the coordinator says this is the user's decision relayed.
    // Declared by the sender, not inferred — the user writing to the coordinator
    // while a question was open proves nothing about what the answer is.
    const passedOn = body.passedOn === true;
    // `--after-turn`: the sender wants this read when the running turn ends,
    // not in the middle of it. Stored on the row, so it holds however many
    // immediate deliveries go past it before that turn ends.
    const afterTurn = body.afterTurn === true;
    // `--answers <seq>`: this message is the answer to that question, which
    // is what takes it off the coordinator's list of things still owed a
    // disposition. An ordinary message does not, because a coordinator also
    // sends resource updates, corrections and pauses to a waiting worker;
    // letting any of those count would be the generic-note loophole again.
    const answers = typeof body.answers === 'number' ? body.answers : undefined;
    // `--task "<one line>"`: the coordinator is reusing this worker on
    // something else and says so, rather than the server guessing a rename
    // out of every message it relays. Sent on the same call as the work, so
    // the name and the brief cannot land apart.
    const task = typeof body.task === 'string' && body.task.trim() ? body.task.trim() : null;
    const recordWorkerAnswer = (): void => {
      if (!from || !input) return;
      const target = ConversationService.getInstance().getConversation(sessionId);
      if (!target?.pickedUpFrom || target.pickedUpFrom !== from) return;
      // Archiving a worker is the coordinator saying it is done with it, and
      // this message withdraws that, so the card comes back rather than the
      // worker running where nobody can see it. A fixture is recorded as
      // created hidden and is left alone; so is a session nobody recorded.
      reopenArchivedWorker(sessionId);
      // Before the message, so the thread reads as the change and then the
      // brief that goes with it. Nothing is written when the name is already
      // right: a follow-up on the same task is the ordinary case and it must
      // not fill the history with rows saying nothing changed.
      const previousTask = currentWorkerTask(from, sessionId);
      if (task && task !== previousTask) {
        appendWorkerEvent(from, 'worker:reassigned', {
          worker: sessionId,
          task,
          previousTask: previousTask ?? '',
        } satisfies WorkerReassignedData);
      }
      appendWorkerEvent(from, 'worker:answered', {
        worker: sessionId,
        text: input,
        summary,
        question: openQuestion(from, sessionId),
        passedOn,
        ...(answers !== undefined ? { answers } : {}),
      } satisfies WorkerAnsweredData);
    };
    // A rename the server quietly drops is worse than a rejected one: the
    // caller believes the card says something it does not, and nothing
    // anywhere reports the difference. Same shape as the `answers` guard.
    if (task !== null) {
      const target = ConversationService.getInstance().getConversation(sessionId);
      if (!from || target?.pickedUpFrom !== from) {
        res.status(400).json({ error: 'task needs --from <the coordinator that dispatched this worker>' });
        return;
      }
    }
    if (answers !== undefined) {
      const target = ConversationService.getInstance().getConversation(sessionId);
      if (!from || target?.pickedUpFrom !== from) {
        res.status(400).json({ error: 'answers needs --from <the coordinator that dispatched this worker>' });
        return;
      }
      if (!isWorkerQuestionSeq(from, sessionId, answers)) {
        res.status(400).json({ error: `event ${answers} is not a question ${sessionId} asked ${from}` });
        return;
      }
    }

    // Who the message is from, as far as the row can say. `from` is a
    // declaration (`session send --from`); the composer declares nothing and
    // is the user; the CLI with no --from declares `origin: 'cli'` and its
    // sender is unknown, which is what the recipient is told.
    const origin = typeof body.origin === 'string' ? body.origin : undefined;
    const fromAgent = Boolean(from) || origin === 'cli';
    const provenance = fromAgent
      ? { source: 'agent' as const, sender: from ?? null, passedOn }
      : { source: 'user' as const, sender: null, passedOn: false };
    if (afterTurn && (!fromAgent || body.interrupt === true)) {
      res.status(400).json({ error: body.interrupt === true
        ? 'after-turn and interrupt contradict each other: one waits for the turn to end, the other ends it'
        : 'after-turn applies to a session send, not the composer' });
      return;
    }

    // The session's next-turn boundary has one owner at a time
    // (turn-admission.ts). Every send takes it for as long as it is deciding
    // and writing, so a drain firing at a turn end, an auto-compaction and an
    // interrupting send cannot each open the next turn. The inbox drain
    // already holds it and says so with its admission id; an `inboxIds` batch
    // from anything that does not is refused rather than let through.
    // A composer send is the user writing to this session. On a project it
    // answers every ask waiting on them from before now (project-needs-you.ts).
    // A drain's inbox batch is not a new send: its rows were counted when sent.
    if (!fromAgent && !inboxIds) noteUserSent(sessionManager, sessionId);

    const admissionToken = typeof body.admission === 'string' ? body.admission : undefined;
    const heldByCaller = admissionToken !== undefined && isAdmissionToken(sessionId, admissionToken);
    if (inboxIds && !heldByCaller) {
      res.status(409).json({ error: 'An inbox batch must be sent by the holder of the session\'s turn admission' });
      return;
    }
    const admission: TurnAdmission | null = heldByCaller
      ? null
      : await admitTurn(sessionId, body.interrupt === true ? 'interrupt' : 'send');

    // Read under the admission, not before it: a coordinator switch holds the
    // admission while it changes provider, and a send queued behind it must
    // go to the provider it finds, not the one that was there when it arrived.
    const provider = resolvers.resolveProvider(sessionId);

    // A Codex send carries the conversation's current effort even when it
    // names none: a send whose process has died respawns from the config the
    // harness remembers, and that config holds whatever the run last started
    // with, so without this an ordinary process replacement restores an older
    // setting. Nothing is attached when nothing is recorded — see
    // knownCodexReasoningEffort in codex-effort.ts.
    const effort = provider === 'codex'
      ? currentCodexReasoningEffort(sessionId, reasoningEffort)
      : null;
    const knownEffort = knownCodexReasoningEffort(effort);
    // Everything below runs inside the admission and releases it on every
    // exit; `admission` is null only for the drain's own request, which takes
    // none of the paths that need it.
    try {
      // A new assignment is not sent into a worker's running turn: it would
      // put the work in hand on hold without anyone deciding to (2026-09-23).
      // Read under the admission, so a drain cannot open a turn after it.
      if (task !== null && !inboxIds && body.interrupt !== true && isMidTurn(sessionManager.inspect(sessionId))) {
        res.status(409).json({
          error: `Not sent: ${sessionId} is in the middle of a turn, and --task would change its assignment. `
            + 'Start a new worker for this, or send it once this one is idle. A correction to its current task needs no --task; '
            + '--interrupt is for when the new work makes the running work pointless.',
        });
        return;
      }
      // A model named for the other provider. On a message queued before a
      // coordinator switch it no longer applies to anything, so the batch
      // goes without it. On a send made now it is someone's explicit choice,
      // and running a different model instead would be a silent substitution,
      // so the send is refused and nothing is saved: the composer keeps the
      // text, and the refusal says how to change the choice.
      const modelProvider = model === undefined ? null
        : CLAUDE_MODELS.some((entry) => entry.id === model) ? 'claude'
        : CODEX_MODELS.some((entry) => entry.id === model) ? 'codex'
        : null;
      if (modelProvider && modelProvider !== provider) {
        if (!inboxIds) {
          const running = provider === 'codex' ? 'Codex' : 'Claude';
          res.status(409).json({
            error: `Not sent: ${model} is a ${modelProvider === 'codex' ? 'Codex' : 'Claude'} model, and this conversation now runs ${running}. `
              + `Choose a ${running} model in the model menu, or send with no model to keep the current one, then send again.`,
          });
          return;
        }
        logger.warn('Queued messages named a model for another provider; sent without it', { sessionId, model, provider });
        model = undefined;
      }

      // A coordinator whose switch did not finish may have one provider on
      // record and another in the config a send would respawn, so nothing is
      // sent until `switch` undoes it. A drain's batch stays unread. A new
      // message is accepted into the inbox and waits there: the receipt is a
      // success, so the composer does not hand the text back for a second
      // send, and the waiting message shows the reason on the thread.
      const unfinished = unfinishedSwitchRefusal(sessionId, ConversationService.getInstance(), latticeCli());
      if (unfinished) {
        if (inboxIds) {
          res.status(409).json({ error: unfinished });
          return;
        }
        const inboxId = enqueueInboxItem({
          sessionId,
          ...provenance,
          text: input ?? '',
          attachmentsJson: attachments.length > 0 ? JSON.stringify(attachments) : null,
          model,
          reasoningEffort,
          afterTurn,
        });
        recordWorkerAnswer();
        appendCustomHarnessEvent(sessionManager, sessionId, INBOX_UNDELIVERABLE_EVENT, { ids: [inboxId], error: unfinished } satisfies InboxUndeliverableData);
        res.json({ ok: true, delivery: 'saved' satisfies SendDelivery, inboxId, note: unfinished });
        return;
      }

      // `--interrupt`: a message written to a mid-turn process is not read until
      // that turn ends (Codex parks it; Claude queues it on stdin), so a change
      // of course has to cancel the turn first. The message is saved to the
      // inbox before anything is cancelled, so a crash or a turn that will not
      // stop loses nothing; then the same escalating stop as the Stop button,
      // waiting for the end of the turn it cancelled (not for the status to
      // read idle — see turn-interrupt.ts); then everything unread, this
      // message with whatever arrived before it, goes as one batch under the
      // admission this route holds. The drain the turn end fires waits behind
      // it and finds nothing left.
      if (body.interrupt === true && !inboxIds && admission && isMidTurn(sessionManager.inspect(sessionId))) {
        const inboxId = enqueueInboxItem({
          sessionId,
          ...provenance,
          text: input ?? '',
          attachmentsJson: attachments.length > 0 ? JSON.stringify(attachments) : null,
          model,
          reasoningEffort,
        });
        recordWorkerAnswer();
        const outcome = await interruptTurn(sessionManager, sessionId, resolvers.interruptWaitMs);
        if (!outcome.ended) {
          logger.warn('Interrupt: turn did not end in time; message stays in the inbox', { sessionId, stopSeq: outcome.stopSeq });
          res.json({
            ok: true,
            delivery: 'saved' satisfies SendDelivery,
            inboxId,
            interrupted: false,
            note: 'The running turn did not end within the wait, so the message was not delivered now. It is saved in the inbox and goes with the next turn boundary or server restart.',
          });
          return;
        }
        logger.info('Interrupted turn before send', { sessionId, via: outcome.via, stopSeq: outcome.stopSeq });
        const drained = await drainHeld(sessionId, admission);
        res.json(receiptForDrain(drained, inboxId, { interrupted: true }));
        return;
      }

      // A dead process means send() respawns the run with --resume rather than
      // writing to stdin, so the pruned-transcript failure applies here too. The
      // harness owns the resumeId it will actually use, so ask it rather than
      // re-resolving. A live process needs no transcript — leave it alone.
      const diagnostics = sessionManager.inspect(sessionId);
      if (diagnostics && !diagnostics.processAlive) {
        if (await refuseIfTranscriptPruned(res, resolvers, sessionId, provider, diagnostics.resumeId)) return;
      }
      // Honest receipt: 'after-turn' means the process is mid-turn and will not
      // read this until it finishes what it is doing.
      const delivery: SendDelivery = isMidTurn(diagnostics) ? 'after-turn' : 'now';

      // A Codex process parks a mid-turn input in memory until its turn ends,
      // and a restart in that window loses it, so the message goes to the
      // session's inbox instead and reaches it at the next turn boundary with
      // whatever else arrived. Claude queues on stdin owned by the daemon,
      // which outlives the server, and reads it mid-turn, so it needs no row.
      // A session with unread items takes the new message the same way, so
      // nothing overtakes what is already waiting.
      if (inboxIds && delivery === 'after-turn') {
        res.status(409).json({ error: 'Session is mid-turn; inbox drain must wait' });
        return;
      }

      // Another agent's message always goes through a row, so the recipient
      // reads it labelled with the declared sender rather than as the user's
      // words, and the label survives a queue, a restart and a compaction.
      // Idle: the row is drained at once, under this route's admission.
      // Mid-turn, it goes into the running turn like the user's does, whoever
      // sent it, because the recipient almost always wants the information
      // now, unless the sender asked it to wait.
      if (!inboxIds && fromAgent && admission) {
        const inboxId = enqueueInboxItem({
          sessionId,
          ...provenance,
          text: input ?? '',
          attachmentsJson: attachments.length > 0 ? JSON.stringify(attachments) : null,
          model,
          reasoningEffort,
          afterTurn,
        });
        recordWorkerAnswer();
        if (delivery === 'after-turn') {
          if (!afterTurn && immediateDeliveryEnabled()) {
            const result = await deliverIntoRunningTurn({ sessionManager, sessionId, admission, inboxId });
            // Refused because the turn ended in between: it is a boundary now,
            // and the row goes the way an idle send's would.
            const drained = result.status === 'rejected' ? await drainHeld(sessionId, admission) : null;
            res.json(drained?.outcome === 'delivered' ? receiptForDrain(drained, inboxId, {}) : receiptForImmediate(result, inboxId));
            return;
          }
          res.json({ ok: true, delivery: 'after-turn' satisfies SendDelivery, inboxId, ...(afterTurn ? { afterTurn: true } : {}) });
          return;
        }
        const drained = await drainHeld(sessionId, admission);
        res.json(receiptForDrain(drained, inboxId, {}));
        return;
      }

      // The user's own message to a session that is mid-turn.
      const userMidTurn = !inboxIds && Boolean(input) && delivery === 'after-turn' && !fromAgent;

      // The row is written before anything is sent, so a crash anywhere below
      // leaves the message durable rather than lost, and the batch it joins is
      // the inbox as it actually stands. Written once — the paths below reuse
      // it rather than adding a second row for the same message.
      let userInboxId: string | undefined;
      if (userMidTurn && input && admission && immediateDeliveryEnabled()) {
        userInboxId = enqueueInboxItem({
          sessionId,
          source: 'user',
          text: input,
          attachmentsJson: attachments.length > 0 ? JSON.stringify(attachments) : null,
          model,
          reasoningEffort,
        });
        recordWorkerAnswer();
        const result = await deliverIntoRunningTurn({ sessionManager, sessionId, admission, inboxId: userInboxId });
        if (result.status !== 'rejected') {
          res.json(receiptForImmediate(result, userInboxId));
          return;
        }
        // Refused: the row stays in the inbox and the paths below treat it as
        // any other message the session could not be given yet.
      }

      if (!inboxIds && (userInboxId !== undefined
        || (provider === 'codex' && delivery === 'after-turn')
        || hasUnreadInboxItems(sessionId))) {
        const inboxId = userInboxId ?? enqueueInboxItem({
          sessionId,
          source: 'user',
          text: input ?? '',
          attachmentsJson: attachments.length > 0 ? JSON.stringify(attachments) : null,
          model,
          reasoningEffort,
        });
        if (!userInboxId) recordWorkerAnswer();
        res.json({ ok: true, delivery: 'after-turn' satisfies SendDelivery, inboxId });
        // A no-op while the turn runs; catches the idle-with-backlog case.
        void drainInbox(sessionId);
        return;
      }

      // Three server-written blocks, in the order a reader needs them. A
      // project session that compacted since its last input gets its preamble
      // and worker roster back; every project session gets the active project
      // state when the record has moved or its copy was compacted away; one
      // whose last turn changed things without noting them gets the nudge;
      // one whose workers were started by someone else since they reported
      // is told so (worker-drift.ts). All are empty otherwise, and this is the path an ordinary
      // message and a drained worker report both take. A failure to build any
      // of them is logged, not fatal: the message still goes.
      let restore = '';
      let orientation = '';
      let drift = '';
      let nudge = '';
      let staleLine = '';
      if (input) {
        try {
          restore = buildCoordinatorRestore(sessionId);
          orientation = buildProjectOrientation(sessionId, latticeCli());
          drift = buildWorkerDriftNote(sessionId, latticeCli());
          nudge = buildProjectStateNudge(sessionId, latticeCli());
          staleLine = buildStaleProjectLine(sessionId, latticeCli());
        } catch (err) {
          logger.warn('Coordinator context restore skipped', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (restore) logger.info('Restoring coordinator context after compaction', { sessionId });
      const outgoing = restore + orientation + drift + nudge + staleLine + (input ?? '');


      const sendExtra = attachments.length > 0 || model || knownEffort
        ? {
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(model ? { model } : {}),
            ...(knownEffort ? { reasoningEffort: knownEffort } : {}),
          }
        : undefined;

      // A drained batch: the thread pairs this with the `input:sent` just
      // before it; the drain marks the rows read from the seq in the response.
      const recordInboxRead = (): number | undefined => {
        if (!inboxIds) return undefined;
        const appended = appendCustomHarnessEvent(sessionManager, sessionId, INBOX_READ_EVENT, { ids: inboxIds } satisfies InboxReadData);
        return appended?.seq;
      };

      try {
        await sessionManager.send(sessionId, outgoing, sendExtra);
        const readSeq = recordInboxRead();
        recordWorkerAnswer();
        res.json({ ok: true, delivery, ...(readSeq !== undefined ? { readSeq } : {}) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        // Unknown session or config lost after restart — the harness SessionManager
        // either lost this session entirely, or recovered it from storage but
        // doesn't have enough context to respawn. Either way, start fresh with
        // config resolved from conversation metadata.
        if (message === 'Unknown session' || message === 'Session config not available') {
          try {
            const resumeId = resolvers.resolveResumeSessionId(sessionId);
            const resolvedCwd = resolvers.resolveWorkingDirectory(sessionId) ?? process.cwd();

            if (await refuseIfTranscriptPruned(res, resolvers, sessionId, provider, resumeId)) return;

            // A recovery is not a new conversation: without this the respawn
            // passed no model at all and the CLI took the account default, which
            // is how a worker dispatched on Fable came back as Opus
            // (resume-model.ts).
            const resumeModel = currentResumeModel(sessionId, provider, model);

            const runId = await sessionManager.start(sessionId, {
              prompt: outgoing,
              cwd: resolvedCwd,
              resume: resumeId !== sessionId ? resumeId : undefined,
              args: resumeModel ? [`--model=${resumeModel}`] : undefined,
              extra: {
                sessionId,
                provider,
                ...(attachments.length > 0 ? { attachments } : {}),
                ...(provider === 'codex' ? {
                  model: resumeModel ?? DEFAULT_CODEX_MODEL_ID,
                  ...(knownEffort ? { reasoningEffort: knownEffort } : {}),
                } : {}),
              },
            });
            resolvers.onSessionStarted?.({
              sessionId,
              provider,
              processId: runId.processId,
              model: resumeModel,
            });

            logger.info('Auto-started session on send (recovered from unknown)', {
              sessionId,
              resumeId: resumeId !== sessionId ? resumeId : undefined,
              model: resumeModel,
              modelSource: model ? 'request' : resumeModel ? 'segment' : 'provider-default',
              ...(effort ? { reasoningEffort: effort.effort, effortSource: effort.source } : {}),
            });
            const readSeq = recordInboxRead();
            recordWorkerAnswer();
            res.json({ ok: true, recovered: true, delivery: 'now' satisfies SendDelivery, ...(readSeq !== undefined ? { readSeq } : {}) });
            return;
          } catch (startErr) {
            const startMessage = startErr instanceof Error ? startErr.message : String(startErr);
            logger.error('Auto-start on send failed', { sessionId, error: startMessage });
            res.status(400).json({ error: startMessage });
            return;
          }
        }

      logger.error('Failed to send input', { sessionId, error: message });
      res.status(400).json({ error: message });
    }
    } finally {
      admission?.release();
    }
  }));

  // The user's emoji reaction on a message in this thread, delivered to the
  // agent it is for (see message-reactions.ts).
  router.post('/:sessionId/reactions', asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = (key: string): string | undefined => (typeof body[key] === 'string' && body[key] ? body[key] as string : undefined);
    const messageId = text('messageId');
    const emoji = text('emoji');
    const excerpt = text('excerpt');
    const action = body.action === 'add' || body.action === 'remove' ? body.action : undefined;
    if (!messageId || !emoji || !excerpt || !action) {
      res.status(400).json({ error: 'reactions need messageId, emoji, excerpt and action (add or remove)' });
      return;
    }
    // One emoji is a few code points; anything longer is not a reaction.
    if ([...emoji].length > 16) {
      res.status(400).json({ error: 'emoji is not a single emoji' });
      return;
    }
    const conversations = ConversationService.getInstance();
    if (!conversations.getConversation(sessionId)) {
      res.status(404).json({ error: `No conversation ${sessionId}` });
      return;
    }
    const sender = text('sender');
    if (sender && !conversations.getConversation(sender)) {
      res.status(404).json({ error: `The message's sender ${sender} is not a conversation here, so the reaction has nowhere to go` });
      return;
    }
    const outcome = await reactToMessage({ threadId: sessionId, messageId, emoji, action, excerpt, worker: text('worker'), sender });
    res.json(outcome);
  }));

  // The agent's own reaction on one of the user's messages in its thread
  // (`lattice session react`). Shown to the user; delivered to nobody.
  router.post('/:sessionId/agent-reactions', asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const emoji = typeof body.emoji === 'string' ? body.emoji.trim() : '';
    const action = body.action === 'add' || body.action === 'remove' ? body.action : undefined;
    const messageId = typeof body.messageId === 'string' && body.messageId ? body.messageId : undefined;
    if (!emoji || !action) {
      res.status(400).json({ error: 'agent reactions need emoji and action (add or remove)' });
      return;
    }
    if (!isSingleEmoji(emoji)) {
      res.status(400).json({ error: `"${emoji}" is not a single emoji; pass the character itself, e.g. 👍` });
      return;
    }
    if (!ConversationService.getInstance().getConversation(sessionId)) {
      res.status(404).json({ error: `No conversation ${sessionId}` });
      return;
    }
    const outcome = agentReact({ threadId: sessionId, emoji, action, messageId });
    res.status(outcome.status === 'no-message' ? 404 : 200).json(outcome);
  }));

  // An agent's question to the user, as a card in its own thread (`lattice ask`).
  router.post('/:sessionId/decisions', asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const body = (req.body ?? {}) as { question?: unknown; options?: unknown };
    const raw: unknown[] = Array.isArray(body.options) ? body.options : [];
    const options = raw.map((o) => (o ?? {}) as { label?: unknown; consequence?: unknown; recommended?: unknown });
    if (typeof body.question !== 'string' || options.some((o) => typeof o.label !== 'string' || typeof o.consequence !== 'string')) {
      res.status(400).json({ error: 'a decision needs a question and options, each with a label and a consequence' });
      return;
    }
    try {
      const asked = askDecision(sessionId, body.question, options.map((o) => ({ label: o.label as string, consequence: o.consequence as string, recommended: o.recommended === true })));
      res.json(asked);
    } catch (err) {
      if (!(err instanceof DecisionError)) throw err;
      res.status(err.status).json({ error: err.message });
    }
  }));

  // The user's answer to one of those questions, from the page only: an agent
  // must not be able to answer its own question.
  router.post('/:sessionId/decisions/:decisionId/answer', asyncHandler(async (req, res) => {
    if (!isFromLatticePage(req.headers)) {
      res.status(403).json({ error: 'Questions are answered from the Lattice page, by the user.' });
      return;
    }
    const { sessionId, decisionId } = req.params;
    const { answer } = (req.body ?? {}) as { answer?: unknown };
    try {
      res.json(await answerDecision(sessionId, decisionId, typeof answer === 'string' ? answer : ''));
    } catch (err) {
      if (!(err instanceof DecisionError)) throw err;
      res.status(err.status).json({ error: err.message });
    }
  }));

  // Compact provider context through the harness's semantic action. Claude's
  // adapter uses its native `/compact` command; Codex uses thread/compact/start.
  router.post('/:sessionId/compact', asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    // A compaction runs a turn on whichever provider the harness would
    // respawn, which is what an unfinished switch leaves in doubt.
    const unfinishedSwitch = unfinishedSwitchRefusal(sessionId, ConversationService.getInstance(), latticeCli());
    if (unfinishedSwitch) {
      res.status(409).json({ error: unfinishedSwitch });
      return;
    }
    const compactProvider = resolvers.resolveProvider(sessionId);

    // A Codex session whose process is gone compacts by spawning a fresh
    // thread, and the harness builds that spawn from the config it remembers —
    // including the effort the run last started with. Resolve the current
    // setting and spawn here instead, so a compaction after a restart does not
    // quietly move the conversation. Recover the session first: a cold server
    // needs its stored resumeId before anything can decide the process is dead.
    if (compactProvider === 'codex') {
      if (!sessionManager.hasSession(sessionId)) sessionManager.recoverFromStorage(sessionId);
      const diagnostics = sessionManager.inspect(sessionId);
      if (diagnostics && !diagnostics.processAlive) {
        if (diagnostics.status !== 'idle') {
          res.status(409).json({ error: `Cannot compact while session is ${diagnostics.status}` });
          return;
        }
        try {
          await startColdCompact(res, sessionId, compactProvider);
        } catch (startErr) {
          const startMessage = startErr instanceof Error ? startErr.message : String(startErr);
          logger.error('Auto-start for compaction failed', { sessionId, error: startMessage });
          res.status(400).json({ error: startMessage });
        }
        return;
      }
    }

    try {
      await sessionManager.compact(sessionId);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Match /send recovery: a cold server may know the conversation but not
      // yet have reconstructed its harness session/config. Spawn a semantic
      // compact run against the persisted provider session.
      if (message === 'Unknown session' || message === 'Session config not available') {
        try {
          await startColdCompact(res, sessionId, compactProvider);
          return;
        } catch (startErr) {
          const startMessage = startErr instanceof Error ? startErr.message : String(startErr);
          logger.error('Auto-start for compaction failed', { sessionId, error: startMessage });
          res.status(400).json({ error: startMessage });
          return;
        }
      }

      logger.error('Failed to compact context', { sessionId, error: message });
      res.status(message.startsWith('Cannot compact while') ? 409 : 400).json({ error: message });
    }
  }));

  // Stop a session's running turn. `ended` answers whether that turn ended,
  // not whether the session is idle: a drain or an auto-compaction can open
  // the next turn a few milliseconds after a stop has worked, and a caller
  // reading status would take that for a stop that failed.
  //
  // This is the user's Stop button. A stop that cut a worker's turn short
  // tells its coordinator the user did it (`noteUserStoppedWorker`); a
  // coordinator's `--interrupt` goes through the send route instead.
  router.post('/:sessionId/stop', asyncHandler(async (req, res) => {
    const { sessionId } = req.params;

    try {
      // A second press while the first stop is in flight is not another stop.
      const before = sessionManager.inspect(sessionId);
      const wasMidTurn = isMidTurn(before) && before?.status !== 'stopping';
      const outcome = await interruptTurn(sessionManager, sessionId, resolvers.interruptWaitMs);
      if (!outcome.ended) logger.warn('Stop: the turn did not end within the wait', { sessionId, stopSeq: outcome.stopSeq });
      if (wasMidTurn) void noteUserStoppedWorker(sessionId);
      res.json({ ok: true, ended: outcome.ended });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to stop session', { sessionId, error: message });
      res.status(400).json({ error: message });
    }
  }));

  // SSE event stream
  router.get('/:sessionId/events', (req: Request, res: Response) => {
    const { sessionId } = req.params;
    // Diagnostic: log what the manager has in memory + storage at the moment
    // of SSE connect, so we can correlate with client-side hydration traces.
    // See debug-hydration-trace for the symptom (CLIENT_STALE_ACTIVE).
    try {
      const log = sessionManager.getLog(sessionId);
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const afterSeq = Number(url.searchParams.get('after') ?? '0');

      const inMemSeqs = log
        ? (log as unknown as { events: { seq: number; type: string }[] }).events.map(e => `${e.seq}/${e.type}`)
        : [];

      logger.info('SSE_CONNECT', {
        sessionId: sessionId.slice(0, 16),
        afterSeq,
        logInMemory: !!log,
        logEventsLen: log?.length ?? 0,
        logEarliestSeq: log?.earliestSeq ?? null,
        storageCount: sessionManager.countInStorage(sessionId),
        subscriberCount: log?.subscriberCount ?? 0,
        inMemSeqs: inMemSeqs.slice(-15).join(','),
      });
    } catch (err) {
      logger.warn('SSE_CONNECT diagnostic failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
    }
    sseHandler(req, res, sessionId);
  });

  // Event history for pagination (scroll-up loading of older events).
  // SSE streams the current turn in real-time; this endpoint serves older events.
  router.get('/:sessionId/history', asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const beforeSeq = Number(req.query.before ?? '0');
    const limit = Math.min(Number(req.query.limit ?? '50'), 200);

    const readOpts = {
      beforeSeq: beforeSeq > 0 ? beforeSeq : undefined,
      limit: limit + 1, // fetch one extra to determine hasMore
    };

    const readEvents = () => {
      const log = sessionManager.getLog(sessionId);
      return log?.hasStorage
        ? log.readFromStorage(sessionId, readOpts)
        : sessionManager.readFromStorage(sessionId, readOpts);
    };

    const events = readEvents();

    if (events.length === 0) {
      res.json({ events: [], hasMore: false });
      return;
    }

    const hasMore = events.length > limit;
    // Trim the extra event from the end it was fetched at. A before-cursor read
    // runs `seq < cursor ORDER BY seq DESC` and is reversed to ascending, so the
    // surplus event is the OLDEST one, at the front. Slicing from the front
    // instead dropped the NEWEST event of every page — and for the cold-load
    // backfill (`before=MAX_SAFE_INTEGER`) the newest event is the `turn:end`
    // that says the session finished, so the client hydrated one event short
    // and rendered a completed session as still working. Forward reads order
    // ascending already, so their surplus is genuinely at the back.
    const page = hasMore
      ? (readOpts.beforeSeq !== undefined ? events.slice(-limit) : events.slice(0, limit))
      : events;

    logger.debug('[HISTORY] Served events', {
      sessionId: sessionId.slice(0, 12),
      direction: readOpts.beforeSeq ? 'before-cursor' : 'forward-replay',
      beforeSeq: readOpts.beforeSeq ?? null,
      count: page.length,
      seqRange: page.length > 0
        ? `${page[0].seq}..${page[page.length - 1].seq}`
        : 'empty',
      hasMore,
    });

    res.json({ events: page, hasMore });
  }));

  // Status snapshot
  router.get('/:sessionId/status', (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const diag = sessionManager.inspect(sessionId);

    if (!diag) {
      res.json({ status: 'idle', activity: null });
      return;
    }

    res.json({
      status: diag.status,
      activity: diag.activity,
      runId: diag.runId,
      resumeId: diag.resumeId,
      processAlive: diag.processAlive,
      eventCount: diag.eventCount,
    });
  });

  return router;
}
