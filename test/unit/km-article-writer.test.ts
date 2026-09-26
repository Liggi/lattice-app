/**
 * The brief that gets sent when a question is followed out of an article.
 *
 * Two things here can be silently wrong rather than visibly broken. The marker
 * is what the written article is located by in the session's transcript, so it
 * has to be the literal opening of the message — if the two drift apart the
 * write hangs and then times out with no visible cause. And the bolding rule is
 * the tooltip generator's whole input: a session that bolds for emphasis
 * produces tooltips explaining "very important".
 */

import { describe, expect, it } from 'vitest';
import {
  WRITE_STYLE_SENTENCES,
  buildWriteMessage,
} from '../../src/web/chat/components/LearningMap/article/write-message.js';
import { extractAnswerAfter } from '../../src/web/chat/components/LearningMap/article/answer-text.js';
import type { ChatMessage } from '../../src/web/chat/types/index.js';

const INPUT = {
  mapName: 'lattice-internals',
  parentTitle: 'Event log',
  parentContent: 'The **event log** is append-only, and the daemon reads it.',
  concept: 'append-only',
  question: 'Tell me more about append-only',
};

describe('buildWriteMessage', () => {
  it('names the article, the map and the question in the first line', () => {
    const { marker } = buildWriteMessage(INPUT);
    expect(marker).toBe(
      'Reading "Event log" on learning map "lattice-internals", '
      + 'I asked: Tell me more about append-only',
    );
  });

  it('opens the message with the marker, so the answer can be found by it', () => {
    const { marker, message } = buildWriteMessage(INPUT);
    expect(message.startsWith(marker)).toBe(true);
  });

  it('carries the parent article in full rather than a summary of it', () => {
    const long = 'x'.repeat(9000);
    const { message } = buildWriteMessage({ ...INPUT, parentContent: long });
    expect(message).toContain(long);
  });

  it('names the subject and asks for the article itself', () => {
    const { message } = buildWriteMessage(INPUT);
    expect(message).toContain('"append-only"');
    expect(message).toContain(WRITE_STYLE_SENTENCES);
  });

  it('says what bold means, not that text should be bolded', () => {
    expect(WRITE_STYLE_SENTENCES).toContain('a term worth its own article');
    expect(WRITE_STYLE_SENTENCES).toContain('never emphasis');
    expect(WRITE_STYLE_SENTENCES).toContain('no title heading');
  });
});

describe('finding the written article in the transcript', () => {
  function userMessage(content: string): ChatMessage {
    return {
      id: 'u', messageId: 'u', type: 'user', content,
      timestamp: '2026-08-31T00:00:00Z',
    };
  }
  function assistantMessage(content: string): ChatMessage {
    return {
      id: 'a', messageId: 'a', type: 'assistant', content,
      timestamp: '2026-08-31T00:00:01Z',
    };
  }

  it('reads the text after the echoed brief, matching on the marker alone', () => {
    const { marker, message } = buildWriteMessage(INPUT);
    const transcript = [
      assistantMessage('something from an earlier turn'),
      userMessage(message),
      assistantMessage('An **append-only** log is never rewritten.'),
    ];
    expect(extractAnswerAfter(transcript, marker)).toEqual({
      found: true,
      text: 'An **append-only** log is never rewritten.',
    });
  });

  it('waits while the brief has not been echoed back yet', () => {
    const { marker } = buildWriteMessage(INPUT);
    expect(extractAnswerAfter([assistantMessage('unrelated')], marker))
      .toEqual({ found: false, text: '' });
  });
});
