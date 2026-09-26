/**
 * input:sent events carrying attachment blocks must produce array-content user
 * messages, which is what MessageItem's image/document renderer keys off.
 *
 * Covers both mappers that read input:sent: the client transcript mapper in
 * useHarnessSession and the server-side UnifiedMessage reader.
 */

import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { eventsToMessages } from '../../src/web/chat/hooks/useHarnessSession.js';
import { eventsToUnifiedMessages } from '../../src/harness/event-message-reader.js';

const IMAGE = {
  type: 'image' as const,
  source: { type: 'base64' as const, media_type: 'image/png', data: 'aW1hZ2U=' },
};
const PDF = {
  type: 'document' as const,
  source: { type: 'base64' as const, media_type: 'application/pdf', data: 'JVBERi0=' },
};

function inputSent(data: Record<string, unknown>, seq = 1): SessionEvent {
  return {
    sessionId: 'conv-test',
    runId: 'run-1',
    seq,
    timestamp: Date.now(),
    type: 'input:sent',
    data,
  } as SessionEvent;
}

const noProviders = new Map<number, never>();

describe('input:sent → transcript message (client mapper)', () => {
  it('emits array content with blocks before text when attachments are present', () => {
    const [message] = eventsToMessages([inputSent({ text: 'what is this?', blocks: [IMAGE] })], noProviders);

    expect(message.type).toBe('user');
    expect(message.content).toEqual([IMAGE, { type: 'text', text: 'what is this?' }]);
  });

  it('keeps text-only input as a plain string', () => {
    const [message] = eventsToMessages([inputSent({ text: 'plain' })], noProviders);

    expect(message.content).toBe('plain');
  });

  it('renders an attachment-only message instead of dropping it', () => {
    const messages = eventsToMessages([inputSent({ text: '', blocks: [IMAGE] })], noProviders);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual([IMAGE]);
  });

  it('still drops a wholly empty input:sent', () => {
    expect(eventsToMessages([inputSent({ text: '' })], noProviders)).toHaveLength(0);
  });

  it('carries multiple attachments in order', () => {
    const [message] = eventsToMessages([inputSent({ text: 'both', blocks: [IMAGE, PDF] })], noProviders);

    expect(message.content).toEqual([IMAGE, PDF, { type: 'text', text: 'both' }]);
  });
});

describe('input:sent → UnifiedMessage (server reader)', () => {
  it('maps attachment blocks into unified image/document blocks', () => {
    const [message] = eventsToUnifiedMessages([inputSent({ text: 'look', blocks: [IMAGE] })]);

    expect(message.role).toBe('user');
    expect(message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
      { type: 'text', text: 'look' },
    ]);
  });

  it('keeps text-only input as a single text block', () => {
    const [message] = eventsToUnifiedMessages([inputSent({ text: 'plain' })]);

    expect(message.content).toEqual([{ type: 'text', text: 'plain' }]);
  });

  it('keeps an attachment-only message', () => {
    const [message] = eventsToUnifiedMessages([inputSent({ text: '', blocks: [PDF] })]);

    expect(message.content).toEqual([
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
    ]);
  });
});
