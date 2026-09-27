/**
 * The registry once held its own idle/streaming state machine, poked from
 * these side effects. It desynced from the event log three separate ways on
 * 2026-08-28 (follow-up sends, task:notification revivals, bare run:ready
 * wakeup revivals) because every path that starts a turn had to remember to
 * poke both stores. The machine is gone: status VALUES derive from the event
 * log, and this callback's only registry job is forwarding event-driven
 * lifecycle PUSHES (session-idle / session-started) to SSE listeners,
 * edge-triggered so paired events (turn:end + run:end; input:sent +
 * run:ready) produce one push, not two.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { createEventSideEffectsCallback } from '../../src/harness/event-side-effects.js';
import { onStatusChanged } from '../../src/services/sessions/session-status-changes.js';
import {
  ActiveConversationRegistry,
  type ActiveConversation,
} from '../../src/services/process/active-conversation-registry.js';

const { onTurnEnd, deliverWorkerReport } = vi.hoisted(() => ({
  onTurnEnd: vi.fn(),
  deliverWorkerReport: vi.fn(async () => {}),
}));

vi.mock('../../src/services/insights/insights-engine.js', () => ({
  InsightsEngine: {
    getInstance: () => ({ onTurnEnd }),
  },
}));

vi.mock('../../src/services/sessions/worker-report-delivery.js', () => ({
  deliverWorkerReport,
}));

const { harnessStatus } = vi.hoisted(() => ({ harnessStatus: { value: 'idle' } }));
vi.mock('../../src/harness/setup.js', () => ({
  getHarnessSessionManager: () => ({ inspect: () => ({ status: harnessStatus.value, processAlive: false }) }),
}));

function registerActive(registry: ActiveConversationRegistry, conversationId: string): void {
  const ac: ActiveConversation = {
    conversationId,
    segment: {
      segmentId: `seg-${conversationId}`,
      provider: 'claude',
      providerSessionId: `psid-${conversationId}`,
      transitionReason: 'conversation_start',
    },
    run: {
      streamingId: `sid-${conversationId}`,
      runVersion: 1,
      startedAt: new Date().toISOString(),
    },
    workingDirectory: '/tmp',
    permissionMode: 'default',
  };
  registry.register(ac);
}

function event(type: SessionEvent['type'], sessionId: string, data: unknown = {}): SessionEvent {
  return { sessionId, runId: 'run-1', seq: 1, timestamp: Date.now(), type, data };
}

describe('createEventSideEffectsCallback — lifecycle pushes', () => {
  let registry: ActiveConversationRegistry;
  let onEvent: (event: SessionEvent) => void;
  let idlePushes: string[];
  let startedPushes: string[];

  beforeEach(() => {
    onTurnEnd.mockReset();
    harnessStatus.value = 'idle';
    registry = new ActiveConversationRegistry();
    idlePushes = [];
    startedPushes = [];
    registry.on('session-idle', (data: { logicalSessionId?: string }) => {
      idlePushes.push(data.logicalSessionId ?? '');
    });
    registry.on('session-started', (data: { logicalSessionId?: string }) => {
      startedPushes.push(data.logicalSessionId ?? '');
    });
    onEvent = createEventSideEffectsCallback(registry);
  });

  it('pushes session-idle on turn:end, triggers insights, and offers the turn for worker-report delivery', () => {
    registerActive(registry, 'conv-a');

    onEvent(event('turn:end', 'conv-a'));

    expect(idlePushes).toEqual(['conv-a']);
    expect(onTurnEnd).toHaveBeenCalledWith('conv-a');
    expect(deliverWorkerReport).toHaveBeenCalledWith('conv-a');
  });

  // A message sent while Claude compacts is answered as a turn of its own the
  // moment the compaction's turn ends; the log then derives streaming, and
  // the idle push waits for the answer's own turn:end.
  it('pushes no idle on a turn:end the log says a held message has turned into a new turn', () => {
    registerActive(registry, 'conv-h');
    onEvent(event('input:sent', 'conv-h', { text: '/compact', source: 'command' }));

    harnessStatus.value = 'streaming';
    onEvent(event('turn:end', 'conv-h', {}));
    expect(idlePushes).toEqual([]);

    harnessStatus.value = 'idle';
    onEvent(event('turn:end', 'conv-h', {}));
    expect(idlePushes).toEqual(['conv-h']);
  });

  it('pushes session-idle ONCE when turn:end and run:end both arrive', () => {
    registerActive(registry, 'conv-b');

    onEvent(event('turn:end', 'conv-b'));
    onEvent(event('run:end', 'conv-b', { reason: 'completed' }));

    expect(idlePushes).toEqual(['conv-b']);
  });

  it('pushes session-idle on run:error without a preceding turn:end', () => {
    registerActive(registry, 'conv-c');

    onEvent(event('run:error', 'conv-c', { message: 'boom' }));

    expect(idlePushes).toEqual(['conv-c']);
  });

  // Follow-up sends go through POST /api/harness/:sessionId/send. input:sent
  // is the event every send path emits, so it is the client's signal that a
  // new turn began after idle.
  it('pushes session-started on input:sent after idle', () => {
    registerActive(registry, 'conv-e');
    onEvent(event('turn:end', 'conv-e'));

    onEvent(event('input:sent', 'conv-e', { text: 'follow-up' }));

    expect(startedPushes).toContain('conv-e');
  });

  // A background task finishing revives the run via task:notification with no
  // input:sent (verified in a live event log, 2026-08-28).
  it('pushes session-started on task:notification after idle', () => {
    registerActive(registry, 'conv-notif');
    onEvent(event('turn:end', 'conv-notif'));
    startedPushes.length = 0;

    onEvent(event('task:notification', 'conv-notif', { taskId: 'bg-1' }));

    expect(startedPushes).toEqual(['conv-notif']);
  });

  // A ScheduledWakeup revival emits ONLY a bare run:ready — no input:sent, no
  // task:notification (live event log, 2026-08-28 11:52, seq 5957).
  it('pushes session-started on a bare run:ready after idle', () => {
    registerActive(registry, 'conv-wake');
    onEvent(event('turn:end', 'conv-wake'));
    startedPushes.length = 0;

    onEvent(event('run:ready', 'conv-wake'));

    expect(startedPushes).toEqual(['conv-wake']);
  });

  it('does not duplicate session-started when input:sent and run:ready pair up', () => {
    registerActive(registry, 'conv-f');
    onEvent(event('turn:end', 'conv-f'));
    startedPushes.length = 0;

    onEvent(event('input:sent', 'conv-f', { text: 'follow-up' }));
    onEvent(event('run:ready', 'conv-f'));

    expect(startedPushes).toEqual(['conv-f']);
  });

  it('is a no-op for events on an unregistered session', () => {
    expect(() => {
      onEvent(event('run:end', 'conv-missing', { reason: 'completed' }));
      onEvent(event('input:sent', 'conv-missing', { text: 'x' }));
    }).not.toThrow();
    expect(idlePushes).toEqual([]);
    expect(startedPushes).toEqual([]);
  });
});

describe('createEventSideEffectsCallback — status-changed pushes', () => {
  it('pushes status-changed for compaction and task starts and finishes, not for content or turn ends', () => {
    const onEvent = createEventSideEffectsCallback(new ActiveConversationRegistry());
    const pushes: string[] = [];
    const off = onStatusChanged((id) => pushes.push(id));
    onEvent(event('context:compaction', 'conv-a', { phase: 'started' }));
    onEvent(event('task:started', 'conv-b', { taskId: 't1', taskType: 'local_bash' }));
    onEvent(event('task:updated', 'conv-b', { taskId: 't1', status: 'completed' }));
    onEvent(event('content', 'conv-c', {}));
    onEvent(event('turn:end', 'conv-c', {}));
    off();
    expect(pushes).toEqual(['conv-a', 'conv-b', 'conv-b']);
  });
});
