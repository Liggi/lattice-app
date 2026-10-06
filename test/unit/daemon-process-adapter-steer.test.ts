/**
 * Steering through the daemon adapter: what the CLI says, and how the
 * adapter reads it.
 *
 * The three things that matter are all about receipts rather than delivery.
 * A CLI that will not acknowledge a uuid must be refused before anything is
 * written, so the caller still owns the message. `queued` is acceptance and
 * nothing more. And whether `started` arrives before or after the running
 * turn's `result` is the only thing that separates a correction folded into
 * that turn from one that became the turn after it — both were observed
 * within 700ms of the same offset on 2026-09-21, so nothing but the ordering
 * distinguishes them.
 *
 * The daemon client is a fake: the assertion target is the frame stream the
 * adapter reads off `claude-message` events and the stdin line it writes back.
 */

import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import type { SpawnConfig, SteerStage } from '@liggi/agent-ui-harness/server';
import { DaemonProcessAdapter } from '../../src/harness/daemon-process-adapter.js';
import type { ProcessManagerClient } from '../../src/process-daemon/process-manager-client.js';
import { parseJson } from '../../src/utils/json.js';

const UUID = '2cc4cb9e-3f4f-40ee-b79e-d99af865940b';
const STREAMING_ID = 'stream-1';
const LIFECYCLE_INIT = {
  type: 'system',
  subtype: 'init',
  session_id: 's1',
  capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'],
};

class FakeDaemon extends EventEmitter {
  written: string[] = [];
  earlyFrames: unknown[] = [];
  async startConversationOptimistic(): Promise<{ streamingId: string }> {
    // Frames the CLI emitted before the handle's listeners were installed.
    for (const message of this.earlyFrames) this.emit('claude-message', { streamingId: STREAMING_ID, message });
    return { streamingId: STREAMING_ID };
  }
  async sendStdinMessage(_id: string, message: string): Promise<boolean> {
    this.written.push(message);
    return true;
  }
  interrupts = 0;
  async interruptConversation(): Promise<boolean> { this.interrupts++; return true; }
  async stopConversation(): Promise<boolean> { return true; }
  async attach(): Promise<{ replayed: number; dropped: number }> { return { replayed: 0, dropped: 0 }; }
  async forceKillConversation(): Promise<boolean> { return true; }
  frame(message: unknown): void {
    this.emit('claude-message', { streamingId: STREAMING_ID, message });
  }
  close(): void {
    this.emit('process-closed', { streamingId: STREAMING_ID, code: 0 });
  }
}

function config(): SpawnConfig {
  return { prompt: 'do the thing', cwd: '/tmp' };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

async function spawned(daemon = new FakeDaemon()) {
  const handle = await new DaemonProcessAdapter(daemon as unknown as ProcessManagerClient).spawn(config());
  return { daemon, handle };
}

/** The stdin line the adapter wrote for a steer, if any. */
function steeredMessage(daemon: FakeDaemon): Record<string, unknown> | undefined {
  const line = daemon.written.find((written) => written.includes(UUID));
  return line ? parseJson(line) as Record<string, unknown> : undefined;
}

describe('daemon adapter steering', () => {
  it('refuses without writing anything when the CLI does not advertise msg_lifecycle_v1', async () => {
    const { daemon, handle } = await spawned();
    daemon.frame({ ...LIFECYCLE_INIT, capabilities: ['interrupt_receipt_v1'] });

    const outcome = await handle.steer!({ input: 'correction', deliveryId: UUID });

    expect(outcome.status).toBe('rejected');
    expect(outcome).toMatchObject({ reason: expect.stringContaining('msg_lifecycle_v1') });
    // The whole point: nothing was handed over, so the caller still owns it.
    expect(daemon.written).toEqual([]);
  });

  it('refuses before any init frame, when lifecycle support is not yet known', async () => {
    const { daemon, handle } = await spawned();
    const outcome = await handle.steer!({ input: 'correction', deliveryId: UUID });
    expect(outcome.status).toBe('rejected');
    expect(daemon.written).toEqual([]);
  });

  it('reads an init frame the CLI emitted before the handle was listening', async () => {
    const daemon = new FakeDaemon();
    daemon.earlyFrames.push(LIFECYCLE_INIT);
    const { handle } = await spawned(daemon);

    const steering = handle.steer!({ input: 'correction', deliveryId: UUID });
    await settle();
    daemon.frame({ type: 'command_lifecycle', command_uuid: UUID, state: 'queued' });
    expect(await steering).toMatchObject({ status: 'accepted' });
  });

  it('steers into a process taken over mid-turn, from the capabilities its stored run:ready kept', async () => {
    // A process taken over mid-turn sends its next system/init only with its next turn.
    const daemon = new FakeDaemon();
    const { handle } = new DaemonProcessAdapter(daemon as unknown as ProcessManagerClient).attach(STREAMING_ID);
    handle.learnCapabilities(LIFECYCLE_INIT.capabilities);

    const steering = handle.steer!({ input: 'correction', deliveryId: UUID });
    await settle();
    daemon.frame({ type: 'command_lifecycle', command_uuid: UUID, state: 'queued' });
    expect(await steering).toMatchObject({ status: 'accepted' });
    expect(steeredMessage(daemon)).toMatchObject({ uuid: UUID, priority: 'next' });
  });

  it('stamps the stdin message with the delivery uuid and priority next, never now', async () => {
    const { daemon, handle } = await spawned();
    daemon.frame(LIFECYCLE_INIT);

    const steering = handle.steer!({ input: 'correction\n', deliveryId: UUID });
    await settle();
    daemon.frame({ type: 'command_lifecycle', command_uuid: UUID, state: 'queued' });
    expect(await steering).toMatchObject({ status: 'accepted' });

    const written = steeredMessage(daemon);
    expect(written).toMatchObject({ type: 'user', uuid: UUID, priority: 'next', message: { role: 'user', content: 'correction' } });
    expect(written).not.toMatchObject({ priority: 'now' });
  });

  it('reports mid-turn incorporation when started arrives before the turn result', async () => {
    const { daemon, handle } = await spawned();
    daemon.frame(LIFECYCLE_INIT);

    const seen: SteerStage[] = [];
    const steering = handle.steer!({ input: 'c', deliveryId: UUID, onStage: (stage) => seen.push(stage) });
    await settle();
    daemon.frame({ type: 'command_lifecycle', command_uuid: UUID, state: 'queued' });
    await steering;

    daemon.frame({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] } });
    daemon.frame({ type: 'command_lifecycle', command_uuid: UUID, state: 'started' });
    daemon.frame({ type: 'result', subtype: 'success' });

    expect(seen).toEqual([
      { kind: 'handed-over' },
      { kind: 'accepted', late: false, detail: expect.objectContaining({ state: 'queued' }) },
      { kind: 'incorporated', where: 'mid-turn', evidence: expect.stringContaining('before') },
    ]);
  });

  it('reports next-turn incorporation when the turn result arrives before started', async () => {
    const { daemon, handle } = await spawned();
    daemon.frame(LIFECYCLE_INIT);

    const seen: SteerStage[] = [];
    const steering = handle.steer!({ input: 'c', deliveryId: UUID, onStage: (stage) => seen.push(stage) });
    await settle();
    daemon.frame({ type: 'command_lifecycle', command_uuid: UUID, state: 'queued' });
    await steering;

    daemon.frame({ type: 'result', subtype: 'success' });
    daemon.frame({ type: 'command_lifecycle', command_uuid: UUID, state: 'started' });

    expect(seen).toEqual([
      { kind: 'handed-over' },
      { kind: 'accepted', late: false, detail: expect.objectContaining({ state: 'queued' }) },
      { kind: 'incorporated', where: 'next-turn', evidence: expect.stringContaining('after') },
    ]);
  });

  it('is uncertain, not rejected, when the process ends before the acknowledgement', async () => {
    const { daemon, handle } = await spawned();
    daemon.frame(LIFECYCLE_INIT);

    const steering = handle.steer!({ input: 'correction', deliveryId: UUID });
    await settle();
    // The message was written; the process dies without acknowledging it.
    daemon.close();

    const outcome = await steering;
    expect(outcome.status).toBe('uncertain');
    expect(steeredMessage(daemon)).toMatchObject({ uuid: UUID });
    expect(await handle.steer!({ input: 'again', deliveryId: UUID })).toMatchObject({ status: 'rejected' });
  });

  it('refuses a delivery id that is not a uuid, because the queue keys on one', async () => {
    const { daemon, handle } = await spawned();
    daemon.frame(LIFECYCLE_INIT);
    const outcome = await handle.steer!({ input: 'correction', deliveryId: 'batch-1' });
    expect(outcome.status).toBe('rejected');
    expect(daemon.written).toEqual([]);
  });
});

describe('daemon adapter interrupt', () => {
  // SIGINT ends the CLI's turn and then exits it, so a message sent after an
  // interrupt had no process to start its turn (2026-09-25).
  it('cancels the turn with a stdin interrupt request rather than a signal', async () => {
    const { daemon, handle } = await spawned();
    handle.signal('SIGINT');
    await settle();

    expect(daemon.interrupts).toBe(0);
    const request = parseJson(daemon.written.at(-1) ?? '') as Record<string, unknown>;
    expect(request).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } });
    expect(handle.alive).toBe(true);
  });
});
