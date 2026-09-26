// @vitest-environment happy-dom
/**
 * useDuplicateMessageDetector — the ordering-anomaly strategy must only fire
 * for text-bearing user messages. Tool results are user-role messages whose
 * timestamps legitimately predate the assistant message they render after
 * (the assistant message is stamped at end-of-stream; its tool results were
 * recorded mid-stream), so they must not be reported.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDuplicateMessageDetector } from '../../src/web/chat/hooks/useDuplicateMessageDetector';
import type { ChatMessage } from '../../src/web/chat/types/index.js';

vi.mock('../../src/web/chat/services/client-telemetry.js', () => ({
  sendClientTelemetry: vi.fn(),
}));

import { sendClientTelemetry } from '../../src/web/chat/services/client-telemetry.js';

function assistant(id: string, ts: string, text = `assistant text for ${id} long enough`): ChatMessage {
  return { id, messageId: id, type: 'assistant', content: text, timestamp: ts } as unknown as ChatMessage;
}

function toolResultUser(id: string, ts: string): ChatMessage {
  return {
    id,
    messageId: id,
    type: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }],
    timestamp: ts,
  } as unknown as ChatMessage;
}

function textUser(id: string, ts: string, text = 'a typed user prompt'): ChatMessage {
  return { id, messageId: id, type: 'user', content: text, timestamp: ts } as unknown as ChatMessage;
}

function run(messages: ChatMessage[]): void {
  renderHook(() =>
    useDuplicateMessageDetector({
      conversationId: 'conv-test',
      messages,
      actionTrace: [],
      connected: true,
      status: 'idle',
    })
  );
}

describe('useDuplicateMessageDetector — ordering anomalies', () => {
  beforeEach(() => {
    vi.mocked(sendClientTelemetry).mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ignores a tool-result user message stamped before the assistant message it follows', () => {
    run([
      textUser('u-1', '2026-08-28T08:48:20.000Z'),
      assistant('a-1', '2026-08-28T08:48:29.599Z'),
      toolResultUser('tr-1', '2026-08-28T08:48:26.727Z'),
    ]);
    expect(sendClientTelemetry).not.toHaveBeenCalled();
  });

  it('still reports a text user prompt stamped before the assistant message it follows', () => {
    run([
      assistant('a-1', '2026-08-28T08:48:29.599Z'),
      textUser('u-1', '2026-08-28T08:48:26.727Z'),
    ]);
    expect(sendClientTelemetry).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendClientTelemetry).mock.calls[0][0];
    expect(call.event).toBe('ordering-anomaly');
  });

  it('stays quiet for a correctly ordered conversation', () => {
    run([
      textUser('u-1', '2026-08-28T08:48:20.000Z'),
      assistant('a-1', '2026-08-28T08:48:25.000Z'),
      textUser('u-2', '2026-08-28T08:48:30.000Z'),
      assistant('a-2', '2026-08-28T08:48:35.000Z'),
    ]);
    expect(sendClientTelemetry).not.toHaveBeenCalled();
  });
});
