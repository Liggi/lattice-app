import { describe, expect, it, vi } from 'vitest';
import { CodexRequestCoordinator } from '../../src/services/process/codex-request-coordinator.js';
import type { PendingQuestionService } from '../../src/services/pending-question-service.js';

function build() {
  const addQuestion = vi.fn();
  const markAnswered = vi.fn();
  const markExpired = vi.fn();
  const questionService = {
    addQuestion,
    markAnswered,
    markExpired,
  } as unknown as PendingQuestionService;
  const coordinator = new CodexRequestCoordinator(questionService);
  const respondToServerRequest = vi.fn();
  const respondToServerRequestError = vi.fn();
  const responder = { respondToServerRequest, respondToServerRequestError };
  return {
    coordinator,
    responder,
    addQuestion,
    markAnswered,
    markExpired,
    respondToServerRequest,
    respondToServerRequestError,
  };
}

describe('CodexRequestCoordinator', () => {
  it('declines unexpected command approvals without asking the user', () => {
    const { coordinator, responder, respondToServerRequest } = build();
    coordinator.handle({
      responder,
      request: {
        id: 1,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread-1' },
      },
      sessionId: 'conv-1',
      streamingId: 'codex-thread-1',
      threadId: 'thread-1',
    });

    expect(respondToServerRequest).toHaveBeenCalledWith(1, { decision: 'decline' });
  });

  it('answers every approval path without creating a user question', () => {
    const {
      coordinator,
      responder,
      addQuestion,
      respondToServerRequest,
    } = build();
    const context = {
      responder,
      sessionId: 'conv-1',
      streamingId: 'codex-thread-1',
      threadId: 'thread-1',
    };

    coordinator.handle({
      ...context,
      request: {
        id: 2,
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread-1' },
      },
    });
    coordinator.handle({
      ...context,
      request: {
        id: 3,
        method: 'item/permissions/requestApproval',
        params: { threadId: 'thread-1' },
      },
    });
    coordinator.handle({
      ...context,
      request: {
        id: 4,
        method: 'execCommandApproval',
        params: { conversationId: 'thread-1' },
      },
    });

    expect(addQuestion).not.toHaveBeenCalled();
    expect(respondToServerRequest.mock.calls).toEqual([
      [2, { decision: 'decline' }],
      [3, { permissions: {}, scope: 'turn' }],
      [4, { decision: 'denied' }],
    ]);
  });

  it('declines unsupported MCP elicitation explicitly instead of hanging', () => {
    const { coordinator, responder, respondToServerRequest } = build();
    coordinator.handle({
      responder,
      request: {
        id: 5,
        method: 'mcpServer/elicitation/request',
        params: { threadId: 'thread-1', mode: 'url', url: 'https://example.test' },
      },
      sessionId: 'conv-1',
      streamingId: 'codex-thread-1',
      threadId: 'thread-1',
    });

    expect(respondToServerRequest).toHaveBeenCalledWith(5, {
      action: 'decline',
      content: null,
    });
  });

  it('persists request_user_input and completes the original JSON-RPC request when answered', () => {
    const { coordinator, responder, addQuestion, respondToServerRequest } = build();
    coordinator.handle({
      responder,
      request: {
        id: 'request-1',
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          questions: [{
            id: 'strategy',
            header: 'Approach',
            question: 'Which approach?',
            options: [
              { label: 'Targeted (Recommended)', description: 'Change the narrow path.' },
              { label: 'Broad', description: 'Refactor the whole flow.' },
            ],
          }],
        },
      },
      sessionId: 'conv-1',
      streamingId: 'codex-thread-1',
      threadId: 'thread-1',
    });

    const questionId = addQuestion.mock.calls[0][0] as string;
    expect(questionId).toMatch(/^codex-question-/);
    expect(addQuestion.mock.calls[0].slice(1)).toEqual([
      'conv-1',
      'codex-thread-1',
      'item-1',
      [{
        question: 'Which approach?',
        header: 'Approach',
        options: [
          { label: 'Targeted (Recommended)', description: 'Change the narrow path.' },
          { label: 'Broad', description: 'Refactor the whole flow.' },
        ],
        multiSelect: false,
      }],
    ]);

    expect(coordinator.answerPendingQuestion(questionId, {
      'Which approach?': 'Targeted (Recommended)',
    })).toBe(true);
    expect(respondToServerRequest).toHaveBeenCalledWith('request-1', {
      answers: { strategy: { answers: ['Targeted (Recommended)'] } },
    });
  });

  it('rejects secret questions instead of persisting plaintext credentials', () => {
    const { coordinator, responder, addQuestion, respondToServerRequestError } = build();
    coordinator.handle({
      responder,
      request: {
        id: 2,
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'thread-1',
          questions: [{ id: 'token', question: 'Token?', isSecret: true }],
        },
      },
      sessionId: 'conv-1',
      streamingId: 'codex-thread-1',
      threadId: 'thread-1',
    });

    expect(addQuestion).not.toHaveBeenCalled();
    expect(respondToServerRequestError).toHaveBeenCalledWith(
      2,
      -32001,
      'Lattice cannot safely collect secret request_user_input values',
    );
  });
});
