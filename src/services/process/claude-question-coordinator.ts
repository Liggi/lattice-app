import crypto from 'node:crypto';
import { createLogger } from '../infrastructure/logger.js';
import type { PendingQuestionService, QuestionDefinition } from '../pending-question-service.js';
import type { ProcessManagerClient } from '@/process-daemon/process-manager-client.js';
import type { ClaudeControlRequestEventData } from '@/process-daemon/types.js';
import type { PermissionTracker } from '../permission-tracker.js';
import { CLAUDE_QUESTION_ID_PREFIX } from '@/types/decisions.js';

const logger = createLogger('ClaudeQuestionCoordinator');

interface WaitingQuestion {
  streamingId: string;
  requestId: string;
  input: Record<string, unknown>;
}

/**
 * Claude's AskUserQuestion, answered by the user in Lattice.
 *
 * With `--permission-prompt-tool stdio` the CLI asks the host for permission
 * to run AskUserQuestion (`can_use_tool`) and takes the answers from the
 * reply: `allow` with `updatedInput.answers` keyed by question text. Treated
 * as an ordinary permission it showed an Allow banner, and allowing it handed
 * back no answer. Here the request is held open as a pending question, shown
 * on the tool's own card, and answered from it.
 *
 * The held request lives in this process only, as Codex's do: a server
 * restart leaves the CLI waiting with nothing to answer it, and the pending
 * row is expired on boot. A turn that ends (stopped, or the process gone)
 * has dropped its request, so its question is expired then too.
 */
export class ClaudeQuestionCoordinator {
  private readonly waiting = new Map<string, WaitingQuestion>();

  constructor(
    private readonly client: ProcessManagerClient,
    private readonly questionService: PendingQuestionService,
    private readonly tracker: PermissionTracker,
  ) {
    const release = ({ streamingId }: { streamingId: string }) => this.expireForStreaming(streamingId);
    client.on('turn-idle', release);
    client.on('process-closed', release);
  }

  /** Holds the request as a pending question. False when the input is not one the card can show. */
  hold(event: ClaudeControlRequestEventData): boolean {
    const questions = event.toolInput.questions;
    if (!Array.isArray(questions) || questions.length === 0) return false;
    const id = `${CLAUDE_QUESTION_ID_PREFIX}${crypto.randomUUID()}`;
    const sessionId = this.tracker.sessionIdForStreaming(event.streamingId) ?? event.streamingId;
    this.questionService.addQuestion(id, sessionId, event.streamingId, event.toolUseId ?? '', questions as QuestionDefinition[]);
    this.waiting.set(id, { streamingId: event.streamingId, requestId: event.requestId, input: event.toolInput });
    logger.info('Claude AskUserQuestion is waiting in Lattice', { id, sessionId, questionCount: questions.length });
    return true;
  }

  /** Hands the answers to the waiting CLI. False when no request is waiting under this id. */
  async answer(id: string, answers: Record<string, string>): Promise<boolean> {
    const waiting = this.take(id);
    if (!waiting) return false;
    return this.client.respondToControlRequest(waiting.streamingId, waiting.requestId, {
      behavior: 'allow',
      updatedInput: { ...waiting.input, answers },
    });
  }

  async dismiss(id: string): Promise<boolean> {
    const waiting = this.take(id);
    if (!waiting) return false;
    return this.client.respondToControlRequest(waiting.streamingId, waiting.requestId, {
      behavior: 'deny',
      message: 'The user dismissed the question without answering it.',
    });
  }

  private expireForStreaming(streamingId: string): void {
    for (const [id, waiting] of this.waiting) {
      if (waiting.streamingId !== streamingId) continue;
      this.waiting.delete(id);
      this.questionService.markExpired(id);
      logger.info('Claude AskUserQuestion expired: its turn ended unanswered', { id, streamingId });
    }
  }

  private take(id: string): WaitingQuestion | undefined {
    const waiting = this.waiting.get(id);
    this.waiting.delete(id);
    return waiting;
  }
}
