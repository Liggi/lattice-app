import crypto from 'node:crypto';
import { createLogger } from '../infrastructure/logger.js';
import type {
  PendingQuestionService,
  QuestionDefinition,
} from '../pending-question-service.js';
import type {
  CodexRequestId,
  CodexServerRequest,
} from './codex-app-server-types.js';

export interface CodexServerRequestResponder {
  respondToServerRequest(id: CodexRequestId, result: unknown): void;
  respondToServerRequestError(id: CodexRequestId, code: number, message: string, data?: unknown): void;
}

export interface CodexServerRequestContext {
  responder: CodexServerRequestResponder;
  request: CodexServerRequest;
  sessionId: string;
  streamingId: string;
  threadId: string;
}

interface ToolRequestQuestion {
  id: string;
  question: string;
  header?: string;
  isSecret?: boolean;
  options?: Array<{ label: string; description?: string }> | null;
}

interface PendingCodexQuestion {
  responder: CodexServerRequestResponder;
  requestId: CodexRequestId;
  streamingId: string;
  questionIdsByPrompt: Map<string, string>;
  autoResolutionTimer?: NodeJS.Timeout;
}

const logger = createLogger('CodexRequestCoordinator');

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' ? value[key] as string : undefined;
}

function stripOtherPrefix(value: string): string {
  return value.startsWith('Other: ') ? value.slice('Other: '.length) : value;
}

/**
 * Owns the client side of Codex app-server requests.
 *
 * Lattice starts Codex threads with approvalPolicy=never, so permission prompts
 * are answered with no additional authority. Genuine request_user_input calls
 * are the exception: they are persisted and shown in the existing question UI,
 * then the exact JSON-RPC request is completed when the user answers.
 */
export class CodexRequestCoordinator {
  private readonly pendingQuestions = new Map<string, PendingCodexQuestion>();

  constructor(private readonly questionService: PendingQuestionService) {}

  handle(context: CodexServerRequestContext): void {
    const { responder, request } = context;

    switch (request.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        responder.respondToServerRequest(request.id, { decision: 'decline' });
        return;

      case 'item/permissions/requestApproval':
        // The current protocol has no decline variant for this response. An
        // empty grant is the explicit no-additional-authority response.
        responder.respondToServerRequest(request.id, {
          permissions: {},
          scope: 'turn',
        });
        return;

      case 'applyPatchApproval':
      case 'execCommandApproval':
        responder.respondToServerRequest(request.id, { decision: 'denied' });
        return;

      case 'item/tool/requestUserInput':
        this.createPendingUserInput(context);
        return;

      case 'mcpServer/elicitation/request':
        // Lattice does not yet have a typed MCP form/OAuth surface. Declining is
        // explicit and lets the turn continue; the old behavior hung forever.
        responder.respondToServerRequest(request.id, {
          action: 'decline',
          content: null,
        });
        logger.warn('Declined unsupported Codex MCP elicitation', {
          sessionId: context.sessionId,
          threadId: context.threadId,
        });
        return;

      case 'item/tool/call':
        responder.respondToServerRequest(request.id, {
          success: false,
          contentItems: [{
            type: 'inputText',
            text: 'Lattice has no client-side dynamic tool registered for this call.',
          }],
        });
        return;

      default:
        responder.respondToServerRequestError(
          request.id,
          -32601,
          `Lattice does not implement Codex server request ${request.method}`,
        );
    }
  }

  answerPendingQuestion(questionId: string, answers: Record<string, string>): boolean {
    const pending = this.takePending(questionId);
    if (!pending) return false;

    const responseAnswers: Record<string, { answers: string[] }> = {};
    for (const [prompt, codexQuestionId] of pending.questionIdsByPrompt) {
      const answer = answers[prompt];
      responseAnswers[codexQuestionId] = {
        answers: typeof answer === 'string' && answer.length > 0
          ? [stripOtherPrefix(answer)]
          : [],
      };
    }

    pending.responder.respondToServerRequest(pending.requestId, {
      answers: responseAnswers,
    });
    return true;
  }

  dismissPendingQuestion(questionId: string): boolean {
    const pending = this.takePending(questionId);
    if (!pending) return false;

    const responseAnswers: Record<string, { answers: string[] }> = {};
    for (const codexQuestionId of pending.questionIdsByPrompt.values()) {
      responseAnswers[codexQuestionId] = { answers: [] };
    }
    pending.responder.respondToServerRequest(pending.requestId, {
      answers: responseAnswers,
    });
    return true;
  }

  /** Expires every question still waiting on this process, once its turn has ended or the process has closed. */
  cancelForStreamingId(streamingId: string): void {
    for (const [questionId, pending] of this.pendingQuestions) {
      if (pending.streamingId !== streamingId) continue;
      this.dismissPendingQuestion(questionId);
      this.questionService.markExpired(questionId);
    }
  }

  private createPendingUserInput(context: CodexServerRequestContext): void {
    const params = record(context.request.params);
    const rawQuestions = params?.questions;
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
      context.responder.respondToServerRequestError(
        context.request.id,
        -32602,
        'Codex request_user_input did not include any questions',
      );
      return;
    }

    const questions: ToolRequestQuestion[] = [];
    for (const rawQuestion of rawQuestions) {
      const question = record(rawQuestion);
      const id = question && stringField(question, 'id');
      const prompt = question && stringField(question, 'question');
      if (!question || !id || !prompt) {
        context.responder.respondToServerRequestError(
          context.request.id,
          -32602,
          'Codex request_user_input contained a malformed question',
        );
        return;
      }
      if (question.isSecret === true) {
        context.responder.respondToServerRequestError(
          context.request.id,
          -32001,
          'Lattice cannot safely collect secret request_user_input values',
        );
        return;
      }

      const options = Array.isArray(question.options)
        ? question.options.flatMap((rawOption) => {
            const option = record(rawOption);
            const label = option && stringField(option, 'label');
            if (!option || !label) return [];
            return [{
              label,
              description: stringField(option, 'description'),
            }];
          })
        : [];
      questions.push({
        id,
        question: prompt,
        header: stringField(question, 'header'),
        options,
      });
    }

    const uniquePrompts = new Set(questions.map((question) => question.question));
    if (uniquePrompts.size !== questions.length) {
      context.responder.respondToServerRequestError(
        context.request.id,
        -32602,
        'Lattice requires unique request_user_input question text',
      );
      return;
    }

    const questionId = `codex-question-${crypto.randomUUID()}`;
    const uiQuestions: QuestionDefinition[] = questions.map((question) => ({
      question: question.question,
      header: question.header,
      options: question.options ?? [],
      multiSelect: false,
    }));

    this.questionService.addQuestion(
      questionId,
      context.sessionId,
      context.streamingId,
      stringField(params!, 'itemId') ?? String(context.request.id),
      uiQuestions,
    );

    const pending: PendingCodexQuestion = {
      responder: context.responder,
      requestId: context.request.id,
      streamingId: context.streamingId,
      questionIdsByPrompt: new Map(
        questions.map((question) => [question.question, question.id]),
      ),
    };
    this.pendingQuestions.set(questionId, pending);

    const autoResolutionMs = params?.autoResolutionMs;
    if (typeof autoResolutionMs === 'number' && autoResolutionMs >= 0) {
      pending.autoResolutionTimer = setTimeout(() => {
        const recommendedAnswers: Record<string, string> = {};
        for (const question of questions) {
          const firstOption = question.options?.[0];
          if (firstOption) recommendedAnswers[question.question] = firstOption.label;
        }
        if (this.answerPendingQuestion(questionId, recommendedAnswers)) {
          this.questionService.markAnswered(questionId, recommendedAnswers);
          logger.info('Auto-resolved non-blocking Codex user input request', {
            questionId,
            autoResolutionMs,
          });
        }
      }, autoResolutionMs);
    }

    logger.info('Codex user input request is waiting in Lattice', {
      questionId,
      sessionId: context.sessionId,
      questionCount: questions.length,
      autoResolutionMs: typeof autoResolutionMs === 'number' ? autoResolutionMs : null,
    });
  }

  private takePending(questionId: string): PendingCodexQuestion | undefined {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) return undefined;
    this.pendingQuestions.delete(questionId);
    if (pending.autoResolutionTimer) clearTimeout(pending.autoResolutionTimer);
    return pending;
  }
}
