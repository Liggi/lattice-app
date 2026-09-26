import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { eventsToMessages } from '../../src/web/chat/hooks/useHarnessSession.js';

function event(type: SessionEvent['type'], data: unknown, seq = 1): SessionEvent {
  return {
    sessionId: 'conv-test',
    runId: 'run-test',
    seq,
    timestamp: 1_700_000_000_000 + seq,
    type,
    data,
  };
}

const providers = new Map<number, 'claude' | 'codex'>([
  [1, 'claude'],
  [2, 'claude'],
]);

describe('compaction event rendering', () => {
  it('turns a live compact boundary into the durable transcript divider message', () => {
    const messages = eventsToMessages([
      event('turn:end', {
        compact: true,
        trigger: 'manual',
        preTokens: 161_300,
        postTokens: 14_949,
        durationMs: 133_891,
        costUsd: 5.21,
      }),
    ], providers);

    expect(messages).toEqual([expect.objectContaining({
      type: 'system',
      systemSubtype: 'compact_boundary',
      compactMetadata: {
        trigger: 'manual',
        preTokens: 161_300,
        postTokens: 14_949,
        durationMs: 133_891,
        costUsd: 5.21,
      },
    })]);
  });

  it('never renders a command-source compact request as a user message', () => {
    expect(eventsToMessages([
      event('input:sent', { text: '/compact', source: 'command' }),
    ], providers)).toEqual([]);
  });

  it('renders provider compaction failure explicitly', () => {
    const messages = eventsToMessages([
      event('context:compaction', {
        phase: 'failed',
        error: 'context service unavailable',
      }),
    ], providers);

    expect(messages).toEqual([expect.objectContaining({
      type: 'error',
      content: 'Context compaction failed: context service unavailable',
    })]);
  });
});
