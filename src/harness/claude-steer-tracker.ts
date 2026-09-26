/**
 * Follows a message steered into a running Claude turn from hand-off to
 * incorporation, reading the CLI's own receipts off its output stream.
 *
 * Two questions, answered by different frames. `command_lifecycle: queued`
 * says the CLI's queue took the uuid — that is acceptance, and all the caller
 * waits for. `started` says it was drawn into a turn, and whether a `result`
 * arrived first is the only thing that distinguishes "folded into the turn
 * that was running" from "became the turn after it" (both runs of the
 * 2026-09-21 proof emitted `started` within 700ms of each other; only the
 * ordering differed).
 *
 * Nothing here talks to a process. The adapter that owns the process feeds
 * every frame through `observe()` and hands `steer()` a function that writes
 * a message; the tracker decides whether to call it and what to report.
 */

import type { SteerOutcome, SteerRequest, SteerStage } from '@liggi/agent-ui-harness/server';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { createLogger } from '../services/infrastructure/logger.js';
import { buildUserContent, parseAttachmentBlocks } from './attachment-blocks.js';

const logger = createLogger('ClaudeSteerTracker');

/**
 * The capability the CLI advertises on `system/init` when it will report what
 * became of a uuid-stamped queued message. Without it a steered message can
 * be delivered but never acknowledged, which is the one outcome worth
 * refusing outright: the caller would be left holding an input it can neither
 * mark delivered nor safely send again.
 */
export const LIFECYCLE_CAPABILITY = 'msg_lifecycle_v1';

/**
 * How long to wait for `command_lifecycle: queued`.
 *
 * Measured at 3ms on SDK 0.3.251 / CLI 2.1.251 (evidence README, 2026-09-21).
 * The caller holds the session's turn boundary while it waits, so this is a
 * ceiling on a wedge rather than a budget for a slow answer.
 */
const QUEUED_ACK_TIMEOUT_MS = 5_000;

/** A uuid, which is what Claude's queue keys its lifecycle frames on. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CommandLifecycleFrame {
  type: 'command_lifecycle';
  command_uuid: string;
  state: 'queued' | 'started' | 'completed' | 'cancelled' | string;
}

function asLifecycleFrame(message: unknown): CommandLifecycleFrame | null {
  if (!message || typeof message !== 'object') return null;
  const frame = message as Partial<CommandLifecycleFrame>;
  if (frame.type !== 'command_lifecycle') return null;
  if (typeof frame.command_uuid !== 'string' || typeof frame.state !== 'string') return null;
  return frame as CommandLifecycleFrame;
}

interface SteerWatch {
  settle: (outcome: SteerOutcome) => void;
  settled: boolean;
  queuedSeen: boolean;
  resultSinceQueued: boolean;
  reported: boolean;
  /**
   * True once `steer()` has answered `uncertain` and stopped waiting. The
   * watch stays alive past that point, and anything it hears afterwards is a
   * late acknowledgement the caller has to be told about: it is holding a
   * batch it believes may never have arrived.
   */
  gaveUp: boolean;
  onStage?: (stage: SteerStage) => void;
}

/** The stdin message a steer writes: the CLI's user message shape, uuid-stamped, `next` never `now`. */
export interface SteeredUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | ContentBlockParam[] };
  parent_tool_use_id: null;
  uuid: string;
  priority: 'next';
}

/**
 * Read attachment blocks out of an adapter `extra` bag. The route already
 * validated these; a failure here means the payload was assembled somewhere
 * else, so it is logged rather than swallowed.
 */
export function attachmentsFromExtra(extra: Record<string, unknown> | undefined, context: string): ContentBlockParam[] {
  if (!extra || extra.attachments === undefined) return [];
  const parsed = parseAttachmentBlocks(extra.attachments);
  if (!parsed.ok) {
    logger.error('Dropping malformed attachments', new Error(parsed.error), { context });
    return [];
  }
  return parsed.blocks;
}

export class ClaudeSteerTracker {
  /** Capabilities from the most recent `system/init`; empty until one arrives. */
  private capabilities = new Set<string>();
  private readonly watches = new Map<string, SteerWatch>();
  private closed = false;

  constructor(private readonly processName: string) {}

  /**
   * Read the frames a steered message's receipt is made of, on the way past.
   * The frames still go wherever they were going; this only looks.
   */
  observe(message: unknown): void {
    const frame = message as { type?: string; subtype?: string; capabilities?: unknown };
    if (frame?.type === 'system' && frame.subtype === 'init') {
      this.capabilities = new Set(Array.isArray(frame.capabilities) ? frame.capabilities as string[] : []);
      return;
    }

    if (this.watches.size === 0) return;

    if (frame?.type === 'result') {
      // A turn ended. Anything queued and not yet started is now, by
      // definition, going to be a turn of its own.
      for (const watch of this.watches.values()) {
        if (watch.queuedSeen && !watch.reported) watch.resultSinceQueued = true;
      }
      return;
    }

    const lifecycle = asLifecycleFrame(message);
    if (!lifecycle) return;
    const watch = this.watches.get(lifecycle.command_uuid);
    if (!watch) return;

    switch (lifecycle.state) {
      case 'queued': {
        if (watch.queuedSeen) return;
        watch.queuedSeen = true;
        const detail = { commandUuid: lifecycle.command_uuid, state: 'queued' };
        if (!watch.settled) {
          watch.settled = true;
          watch.settle({ status: 'accepted', detail });
        }
        // Late: `steer()` has already answered `uncertain` and the caller is
        // holding the batch as unresolved. This is the evidence that resolves
        // it, so it is worth as much now as it would have been in time.
        if (watch.gaveUp) {
          logger.info('Steered message was acknowledged after the wait had given up', {
            processName: this.processName,
            commandUuid: lifecycle.command_uuid,
          });
        }
        watch.onStage?.({ kind: 'accepted', late: watch.gaveUp, detail });
        return;
      }
      case 'started': {
        if (watch.reported) return;
        watch.reported = true;
        watch.onStage?.({
          kind: 'incorporated',
          where: watch.resultSinceQueued ? 'next-turn' : 'mid-turn',
          evidence: watch.resultSinceQueued
            ? 'command_lifecycle started arrived after the running turn\'s result frame'
            : 'command_lifecycle started arrived before the running turn\'s result frame',
        });
        return;
      }
      case 'cancelled':
        // Only an interrupt that asked for it produces this, and nothing here
        // interrupts. If it ever appears the message never ran, so say so
        // loudly rather than leaving a delivered receipt standing unexplained.
        logger.warn('Steered message was cancelled before it ran', {
          processName: this.processName,
          commandUuid: lifecycle.command_uuid,
        });
        if (!watch.settled) {
          watch.settled = true;
          watch.settle({ status: 'rejected', reason: 'The queue cancelled the message before it ran' });
        }
        this.watches.delete(lifecycle.command_uuid);
        return;
      case 'completed':
        this.watches.delete(lifecycle.command_uuid);
        return;
      default:
        return;
    }
  }

  /**
   * Deliver into the running turn by handing `write` a uuid-stamped
   * `priority: "next"` message.
   *
   * The capability is checked before anything is written, and that ordering
   * is the point: a CLI that will not acknowledge the uuid must leave this
   * method having delivered nothing, so the caller still owns the input. Once
   * the write has happened there is no taking it back, which is why a missing
   * acknowledgement afterwards is `uncertain` rather than a refusal.
   *
   * `next`, never `now`. `now` aborts the running turn — that is what it is
   * for — and this path exists to reach work without destroying it.
   */
  async steer(request: SteerRequest, write: (message: SteeredUserMessage) => void): Promise<SteerOutcome> {
    if (this.closed) return { status: 'rejected', reason: 'Claude session is not running' };
    if (!UUID_PATTERN.test(request.deliveryId)) {
      return { status: 'rejected', reason: 'A steered message must be stamped with a uuid' };
    }
    if (this.watches.has(request.deliveryId)) {
      return { status: 'rejected', reason: 'That delivery is already in flight' };
    }
    if (!this.capabilities.has(LIFECYCLE_CAPABILITY)) {
      return {
        status: 'rejected',
        reason: this.capabilities.size === 0
          ? 'No system/init seen yet, so the CLI\'s lifecycle support is unknown'
          : `CLI does not advertise ${LIFECYCLE_CAPABILITY}, so a steered message could not be acknowledged`,
      };
    }

    const text = request.input.endsWith('\n') ? request.input.slice(0, -1) : request.input;
    const attachments = attachmentsFromExtra(request.extra, `steer:${this.processName}`);
    if (!text.trim() && attachments.length === 0) {
      return { status: 'rejected', reason: 'Nothing to steer with' };
    }

    let settle!: (outcome: SteerOutcome) => void;
    const settled = new Promise<SteerOutcome>((resolve) => { settle = resolve; });
    const watch: SteerWatch = {
      settle,
      settled: false,
      queuedSeen: false,
      resultSinceQueued: false,
      reported: false,
      gaveUp: false,
      ...(request.onStage ? { onStage: request.onStage } : {}),
    };
    this.watches.set(request.deliveryId, watch);

    // The last instant at which "nothing was delivered" is still true. After
    // the write the message is in the CLI's hands, so a caller that dies here
    // must treat the delivery as unresolved rather than free to repeat.
    request.onStage?.({ kind: 'handed-over' });

    try {
      write({
        type: 'user',
        message: { role: 'user', content: buildUserContent(text, attachments) },
        parent_tool_use_id: null,
        uuid: request.deliveryId,
        priority: 'next',
      });
    } catch (error) {
      // The write itself failed before anything could reach the CLI's queue.
      // Whether it got as far as the daemon is not knowable from here.
      this.watches.delete(request.deliveryId);
      return { status: 'uncertain', reason: `Writing the steered message failed: ${error instanceof Error ? error.message : String(error)}` };
    }

    const timeout = new Promise<SteerOutcome>((resolve) => {
      setTimeout(() => resolve({
        status: 'uncertain',
        reason: `No command_lifecycle acknowledgement within ${QUEUED_ACK_TIMEOUT_MS}ms; the message was handed over and must not be re-sent`,
      }), QUEUED_ACK_TIMEOUT_MS).unref?.();
    });

    const outcome = await Promise.race([settled, timeout]);
    if (outcome.status === 'uncertain') {
      // Keep watching: a late acknowledgement is what resolves the batch the
      // caller is now holding, and the watch is also what stops a second
      // steer reusing this uuid.
      watch.gaveUp = true;
      logger.warn('Steered message was not acknowledged in time', {
        processName: this.processName,
        deliveryId: request.deliveryId,
      });
    }
    if (outcome.status === 'rejected') this.watches.delete(request.deliveryId);
    return outcome;
  }

  /** The process is gone. Anything unacknowledged stays the caller's to hold. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [deliveryId, watch] of this.watches) {
      if (watch.settled) continue;
      watch.settled = true;
      watch.settle({ status: 'uncertain', reason: 'The Claude session ended before the message was acknowledged' });
      logger.warn('Claude session ended with a steered message unacknowledged', { processName: this.processName, deliveryId });
    }
    this.watches.clear();
  }
}
