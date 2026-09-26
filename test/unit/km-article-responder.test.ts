/**
 * The pure parts of the article-surface ask flow: which session answers, what
 * gets sent to it, and how one answer is picked out of that session's
 * transcript.
 *
 * These are the three places where the flow can be silently wrong rather than
 * visibly broken — asking the wrong session, sending a message with no
 * grounding in it, or reading back somebody else's turn as the answer.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ANSWER_STYLE_SENTENCE,
  buildAskMessage,
} from '../../src/web/chat/components/LearningMap/article/ask-message.js';
import { resolveResponder } from '../../src/web/chat/components/LearningMap/article/responder.js';
import {
  extractAnswerAfter,
  messageText,
} from '../../src/web/chat/components/LearningMap/article/answer-text.js';
import type { ChatMessage } from '../../src/web/chat/types/index.js';

function userMessage(content: ChatMessage['content'], id = 'u'): ChatMessage {
  return { id, messageId: id, type: 'user', content, timestamp: '2026-08-31T00:00:00Z' };
}

function assistantMessage(
  content: ChatMessage['content'],
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: 'a',
    messageId: 'a',
    type: 'assistant',
    content,
    timestamp: '2026-08-31T00:00:01Z',
    ...extra,
  };
}

describe('buildAskMessage', () => {
  it('names the article, the map and the span, then the question', () => {
    const message = buildAskMessage({
      articleTitle: 'The harness event log',
      mapName: 'lattice-internals',
      quote: 'Events flow through EventLog',
      question: 'What buffers these across a restart?',
    });

    expect(message).toBe(
      'In the article "The harness event log" on learning map "lattice-internals", '
      + 'about the highlighted span "Events flow through EventLog": '
      + 'What buffers these across a restart?'
      + `\n\n${ANSWER_STYLE_SENTENCE}`,
    );
  });

  it('never truncates the quote', () => {
    const quote = 'x'.repeat(4000);
    expect(buildAskMessage({
      articleTitle: 'T', mapName: 'M', quote, question: 'why?',
    })).toContain(quote);
  });

  it('tells the agent to answer concisely in markdown', () => {
    expect(ANSWER_STYLE_SENTENCE).toContain('markdown');
    expect(ANSWER_STYLE_SENTENCE).toContain('concisely');
  });
});

describe('resolveResponder', () => {
  const neverCalled = {
    createConversation: vi.fn(async () => 'conv-should-not-happen'),
    saveMapDefault: vi.fn(async () => undefined),
  };

  it("prefers the article's own session over everything else", async () => {
    const createConversation = vi.fn(async () => 'conv-new');
    const saveMapDefault = vi.fn(async () => undefined);

    const result = await resolveResponder({
      articleConv: 'conv-source',
      mapDefaultConv: 'conv-map-default',
      createConversation,
      saveMapDefault,
    }, 'ask');

    expect(result).toEqual({
      conversationId: 'conv-source',
      deliveredWithCreate: false,
      defaultSaveError: null,
    });
    expect(createConversation).not.toHaveBeenCalled();
    expect(saveMapDefault).not.toHaveBeenCalled();
  });

  it("falls back to the map's default when the article has no provenance", async () => {
    const result = await resolveResponder({
      articleConv: null,
      mapDefaultConv: 'conv-map-default',
      ...neverCalled,
    }, 'ask');

    expect(result.conversationId).toBe('conv-map-default');
    expect(result.deliveredWithCreate).toBe(false);
    expect(neverCalled.createConversation).not.toHaveBeenCalled();
  });

  it('treats a blank id as absent rather than as a session', async () => {
    const createConversation = vi.fn(async () => 'conv-new');
    const result = await resolveResponder({
      articleConv: '   ',
      mapDefaultConv: '',
      createConversation,
      saveMapDefault: vi.fn(async () => undefined),
    }, 'ask');

    expect(createConversation).toHaveBeenCalledOnce();
    expect(result.conversationId).toBe('conv-new');
  });

  it('creates a session with the ask as its first message and saves it as the default', async () => {
    const createConversation = vi.fn(async () => 'conv-new');
    const saveMapDefault = vi.fn(async () => undefined);

    const result = await resolveResponder({
      articleConv: null,
      mapDefaultConv: null,
      createConversation,
      saveMapDefault,
    }, 'the full ask message');

    expect(createConversation).toHaveBeenCalledWith('the full ask message');
    expect(saveMapDefault).toHaveBeenCalledWith('conv-new');
    expect(result).toEqual({
      conversationId: 'conv-new',
      deliveredWithCreate: true,
      defaultSaveError: null,
    });
  });

  it('reports a failed default save without losing the conversation', async () => {
    const result = await resolveResponder({
      articleConv: null,
      mapDefaultConv: null,
      createConversation: async () => 'conv-new',
      saveMapDefault: async () => { throw new Error('map went away'); },
    }, 'ask');

    expect(result.conversationId).toBe('conv-new');
    expect(result.deliveredWithCreate).toBe(true);
    expect(result.defaultSaveError).toBe('map went away');
  });

  it('propagates a failure to create the conversation', async () => {
    await expect(resolveResponder({
      articleConv: null,
      mapDefaultConv: null,
      createConversation: async () => { throw new Error('no provider credentials'); },
      saveMapDefault: async () => undefined,
    }, 'ask')).rejects.toThrow('no provider credentials');
  });
});

describe('messageText', () => {
  it('reads a plain string body', () => {
    expect(messageText('hello')).toBe('hello');
  });

  it('keeps text blocks and drops tool use and thinking', () => {
    expect(messageText([
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'The answer' },
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      { type: 'text', text: ' continues.' },
    ])).toBe('The answer continues.');
  });
});

describe('extractAnswerAfter', () => {
  const ask = 'In the article "A" on learning map "M", about the highlighted span "s": why?';

  it('reports not-found until the question appears in the transcript', () => {
    expect(extractAnswerAfter([
      userMessage('something else'),
      assistantMessage('an earlier answer'),
    ], ask)).toEqual({ found: false, text: '' });
  });

  it('ignores everything before the question', () => {
    const result = extractAnswerAfter([
      userMessage('an earlier question', 'u0'),
      assistantMessage('an earlier answer'),
      userMessage(ask, 'u1'),
      assistantMessage('The real answer.'),
    ], ask);

    expect(result).toEqual({ found: true, text: 'The real answer.' });
  });

  it('is found but empty while the session is still queued behind another turn', () => {
    expect(extractAnswerAfter([userMessage(ask)], ask)).toEqual({ found: true, text: '' });
  });

  it('joins successive assistant messages and skips subagent output', () => {
    const result = extractAnswerAfter([
      userMessage(ask),
      assistantMessage([{ type: 'text', text: 'First part.' }]),
      assistantMessage('Nested subagent chatter.', { parentToolUseId: 'toolu_1' }),
      assistantMessage([
        { type: 'tool_use', id: 't', name: 'Read', input: {} },
        { type: 'text', text: 'Second part.' },
      ]),
    ], ask);

    expect(result.text).toBe('First part.\n\nSecond part.');
  });

  it('reads the newer turn when the same question was asked twice', () => {
    const result = extractAnswerAfter([
      userMessage(ask, 'u1'),
      assistantMessage('Old answer.'),
      userMessage(ask, 'u2'),
      assistantMessage('New answer.'),
    ], ask);

    expect(result.text).toBe('New answer.');
  });

  it('matches when the sent input carried extra wrapping', () => {
    const result = extractAnswerAfter([
      userMessage(`${ask}\n\n[Notes on your earlier output]`),
      assistantMessage('Answered anyway.'),
    ], ask);

    expect(result).toEqual({ found: true, text: 'Answered anyway.' });
  });
});
