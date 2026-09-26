import { Router } from 'express';
import { LatticeError } from '@/types/index.js';
import { RequestWithRequestId } from '@/types/express.js';
import { asyncHandler } from '@/middleware/error-handler.js';
import { PendingQuestionService, PendingQuestion } from '@/services/pending-question-service.js';
import { ClaudeHistoryReader } from '@/services/sessions/claude-history-reader.js';
import { ConversationService } from '@/services/sessions/conversation-service.js';
import { createLogger } from '@/services/infrastructure/logger.js';
import type { CodexRequestCoordinator } from '@/services/process/codex-request-coordinator.js';

export interface AnswerPendingQuestionRequest {
  answers: Record<string, string>;
}

/**
 * Format the resume prompt that provides the question answer context to Claude
 */
function _formatResumePrompt(question: PendingQuestion, answers: Record<string, string>): string {
  const parts: string[] = ['Regarding your earlier question:'];

  for (const q of question.questions) {
    const answer = answers[q.question];
    if (answer) {
      // Find the selected option to get its description
      const selectedOption = q.options.find(opt => opt.label === answer);
      const description = selectedOption?.description ? ` (${selectedOption.description})` : '';

      if (q.header) {
        parts.push(`\n**${q.header}**: ${q.question}`);
      } else {
        parts.push(`\n${q.question}`);
      }
      parts.push(`The user selected: **${answer}**${description}`);
    }
  }

  parts.push('\nPlease continue with your task, taking this answer into account.');

  return parts.join('\n');
}

export function createPendingQuestionRoutes(
  pendingQuestionService: PendingQuestionService,
  _historyReader: ClaudeHistoryReader,
  codexRequestCoordinator?: CodexRequestCoordinator,
): Router {
  const router = Router();
  const logger = createLogger('PendingQuestionRoutes');
  const conversationService = ConversationService.getInstance();

  router.get('/', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { sessionId } = req.query as { sessionId?: string };

    let questions: PendingQuestion[];
    if (sessionId) {
      // Unified conversation IDs (conv-*) map to provider-session segments.
      // Resolve all Claude segment session IDs and return pending questions for them.
      if (sessionId.startsWith('conv-')) {
        const conversation = conversationService.getConversation(sessionId);
        if (!conversation) {
          questions = [];
        } else {
          const providerSessionIds = new Set([
            sessionId,
            ...conversation.segments.map(segment => segment.providerSessionId),
          ]);
          questions = pendingQuestionService.getAllPending()
            .filter(q => providerSessionIds.has(q.sessionId));
        }
      } else {
        questions = pendingQuestionService.getQuestionsBySession(sessionId)
          .filter(q => q.status === 'pending');
      }
    } else {
      questions = pendingQuestionService.getAllPending();
    }

    // Resolve conversationId for each question so the frontend can map to sidebar sessions
    const enriched = questions.map(q => {
      const directConversation = q.sessionId.startsWith('conv-')
        ? conversationService.getConversation(q.sessionId)
        : null;
      const conv = directConversation
        ? { conversation: directConversation }
        : conversationService.getConversationByProviderSession(q.sessionId);
      return conv
        ? { ...q, conversationId: conv.conversation.conversationId }
        : q;
    });

    if (enriched.length > 0) {
      logger.debug('Pending questions poll returned results', {
        requestId: req.requestId,
        count: enriched.length,
        filter: { sessionId }
      });
    }

    res.json({ questions: enriched });
  }));

  router.get('/:questionId', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { questionId } = req.params;

    const question = pendingQuestionService.getQuestion(questionId);
    if (!question) {
      throw new LatticeError('QUESTION_NOT_FOUND', 'Pending question not found', 404);
    }

    res.json({ question });
  }));

  // Answer a pending question and resume the session
  router.post('/:questionId/answer', asyncHandler(async (req: RequestWithRequestId<AnswerPendingQuestionRequest>, res) => {
    const requestId = req.requestId;
    const { questionId } = req.params;
    const { answers } = req.body;

    logger.info('Answer pending question request', {
      requestId,
      questionId,
      answerCount: answers ? Object.keys(answers).length : 0
    });

    if (!answers || typeof answers !== 'object' || Object.keys(answers).length === 0) {
      throw new LatticeError('INVALID_ANSWER', 'Answers must be a non-empty object', 400);
    }

    // Get the pending question
    const question = pendingQuestionService.getQuestion(questionId);
    if (!question) {
      throw new LatticeError('QUESTION_NOT_FOUND', 'Pending question not found', 404);
    }

    if (question.status !== 'pending') {
      throw new LatticeError('ALREADY_ANSWERED', 'Question has already been answered', 400);
    }

    // A live Codex request must receive its JSON-RPC response before the row is
    // hidden. Legacy Claude questions have no live responder and keep the
    // existing persistence-only behavior.
    const isCodexQuestion = questionId.startsWith('codex-question-');
    const answeredLiveCodexRequest = codexRequestCoordinator
      ?.answerPendingQuestion(questionId, answers) ?? false;
    if (isCodexQuestion && !answeredLiveCodexRequest) {
      throw new LatticeError(
        'CODEX_REQUEST_NOT_ACTIVE',
        'This Codex question is no longer attached to a live request',
        409,
      );
    }

    pendingQuestionService.markAnswered(questionId, answers);

    logger.info('Pending question answered', {
      requestId,
      questionId,
      originalSessionId: question.sessionId,
    });

    res.json({
      success: true,
      message: 'Question answered'
    });
  }));

  // Mark a question as expired (user dismissed it)
  router.post('/:questionId/expire', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { questionId } = req.params;

    const isCodexQuestion = questionId.startsWith('codex-question-');
    const dismissedLiveCodexRequest = codexRequestCoordinator
      ?.dismissPendingQuestion(questionId) ?? false;
    if (isCodexQuestion && !dismissedLiveCodexRequest) {
      throw new LatticeError(
        'CODEX_REQUEST_NOT_ACTIVE',
        'This Codex question is no longer attached to a live request',
        409,
      );
    }
    const success = pendingQuestionService.markExpired(questionId);
    if (!success) {
      throw new LatticeError('QUESTION_NOT_FOUND', 'Pending question not found', 404);
    }

    res.json({ success: true });
  }));

  return router;
}
