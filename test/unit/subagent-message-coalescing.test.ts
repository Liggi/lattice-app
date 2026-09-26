/**
 * A background subagent keeps streaming after the orchestrator's turn:end.
 * Fragments of one API message that straddle that boundary must coalesce into
 * ONE ChatMessage — the coalesce map used to reset at turn boundaries, which
 * split them into two messages sharing one id (React key collision, and the
 * source of every "duplicate message id" telemetry event).
 *
 * Event shape taken verbatim from the live log that proved it.
 */
import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { eventsToMessages } from '../../src/web/chat/hooks/useHarnessSession.js';

function event(type: SessionEvent['type'], data: unknown, seq: number): SessionEvent {
  return {
    sessionId: 'conv-test',
    runId: 'run-test',
    seq,
    timestamp: 1_700_000_000_000 + seq,
    type,
    data,
  };
}

const providers = new Map<number, 'claude'>();

describe('message coalescing across turn boundaries', () => {
  it('keeps one message when a subagent fragment arrives after turn:end', () => {
    const messages = eventsToMessages([
      event('content', {
        messageId: 'msg_D4',
        parentToolUseId: 'toolu_HGCU',
        blocks: [{ type: 'text', text: 'Export complete and ' }],
      }, 6413),
      event('turn:end', {}, 6417),
      event('content', {
        messageId: 'msg_D4',
        parentToolUseId: 'toolu_HGCU',
        blocks: [{ type: 'text', text: 'verified.' }],
      }, 6460),
    ], providers);

    const assistant = messages.filter((m) => m.type === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].messageId).toBe('h-msg_D4');
    const text = Array.isArray(assistant[0].content)
      ? assistant[0].content.map((b) => ('text' in b ? b.text : '')).join('')
      : assistant[0].content;
    expect(text).toContain('Export complete and');
    expect(text).toContain('verified.');
  });

  it('still renders different messages in different turns separately', () => {
    const messages = eventsToMessages([
      event('content', { messageId: 'msg_A', blocks: [{ type: 'text', text: 'first turn' }] }, 1),
      event('turn:end', {}, 2),
      event('content', { messageId: 'msg_B', blocks: [{ type: 'text', text: 'second turn' }] }, 3),
    ], providers);

    const assistant = messages.filter((m) => m.type === 'assistant');
    expect(assistant.map((m) => m.messageId)).toEqual(['h-msg_A', 'h-msg_B']);
  });

  it('does not merge a respawned run reusing the previous run\'s message id', () => {
    // Message ids are only unique within one process. A respawn (idle exit →
    // follow-up, or a cassette replay) can legitimately reuse an id; the
    // coalesce scope resets at run:start so the reply renders as its own
    // message instead of vanishing into the first run's.
    const messages = eventsToMessages([
      event('run:start', {}, 1),
      event('content', { messageId: 'msg_A', blocks: [{ type: 'text', text: 'first run' }] }, 2),
      event('turn:end', {}, 3),
      event('run:end', {}, 4),
      event('run:start', {}, 5),
      event('content', { messageId: 'msg_A', blocks: [{ type: 'text', text: 'second run' }] }, 6),
      event('turn:end', {}, 7),
    ], providers);

    const assistant = messages.filter((m) => m.type === 'assistant');
    expect(assistant).toHaveLength(2);
    const texts = assistant.map((m) => Array.isArray(m.content)
      ? m.content.map((b) => ('text' in b ? b.text : '')).join('')
      : m.content);
    expect(texts[0]).toContain('first run');
    expect(texts[1]).toContain('second run');
  });
});
