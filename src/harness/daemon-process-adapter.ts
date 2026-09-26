/**
 * DaemonProcessAdapter — bridges Lattice's daemon IPC to harness's ProcessAdapter interface.
 *
 * The daemon owns Claude PTY processes. This adapter translates between:
 * - Daemon IPC events (claude-message, process-closed, etc.)
 * - Harness ProcessHandle (stdout AsyncIterable, write, signal, exited)
 *
 * Key insight: the daemon's `claude-message.data.message` IS the raw Claude CLI JSON
 * (system/init, assistant, user, result types) — exactly what harness's normalizeClaude expects.
 * So we re-serialize it as a JSON line and push it through stdout.
 */

import { randomUUID } from 'crypto';
import type { ProcessAdapter, ProcessHandle, SpawnConfig, SteerOutcome, SteerRequest } from '@liggi/agent-ui-harness/server';
import type { ProcessManagerClient } from '../process-daemon/process-manager-client.js';
import type { ClaudeMessageEventData, ProcessClosedEventData } from '../process-daemon/types.js';
import type { ConversationConfig } from '../types/index.js';
import { createLogger } from '../services/infrastructure/logger.js';
import { buildUserContent, parseAttachmentBlocks } from './attachment-blocks.js';
import { ClaudeSteerTracker } from './claude-steer-tracker.js';

const logger = createLogger('DaemonProcessAdapter');

export class DaemonProcessAdapter implements ProcessAdapter {
  /** StreamingIds spawned by the harness — used to gate old-pathway message persistence. */
  readonly managedStreamingIds = new Set<string>();

  constructor(private client: ProcessManagerClient) {}

  async spawn(config: SpawnConfig): Promise<ProcessHandle> {
    // Map harness SpawnConfig to Lattice ConversationConfig
    const daemonConfig: ConversationConfig & { resumedSessionId?: string } = {
      initialPrompt: config.prompt,
      workingDirectory: config.cwd ?? process.cwd(),
      resumedSessionId: config.resume,
      ...(config.env ? { envOverrides: config.env } : {}),
    };

    // Pass through extra args as model/permissionMode if present
    const extra = config.args ?? [];
    for (const arg of extra) {
      if (arg.startsWith('--model=')) {
        daemonConfig.model = arg.slice('--model='.length);
      }
      if (arg.startsWith('--permission-mode=')) {
        daemonConfig.permissionMode = arg.slice('--permission-mode='.length);
      }
    }

    // Adapter-specific fields from SpawnConfig.extra
    if (config.extra?.systemPrompt) {
      daemonConfig.systemPrompt = config.extra.systemPrompt as string;
    }
    // Spawn-time attachments reach the daemon as ConversationConfig.initialContent,
    // which process-daemon merges into the CLI's first stdin message. Callers spell
    // them either way: `initialContent` (the resume/inject routes) or `attachments`
    // (the harness-wide key the SDK adapter and input:sent event use).
    const spawnAttachments = config.extra?.initialContent ?? config.extra?.attachments;
    if (spawnAttachments) {
      daemonConfig.initialContent = spawnAttachments as ConversationConfig['initialContent'];
    }

    // Session-index injection intentionally disabled (2026-05-30): the
    // "Past Lattice sessions" block was a large always-on addition to every
    // system prompt, paid in cache-recreation on every (re)spawn. Summaries
    // are still generated and remain queryable on demand via the `lattice`
    // CLI / UI. Re-enable by restoring buildSystemPromptIndexBlock() here.

    const earlyMessages: ClaudeMessageEventData[] = [];
    const earlyClosed: ProcessClosedEventData[] = [];
    const earlyErrors: Array<{ streamingId: string; error: string }> = [];

    const captureMessage = (data: ClaudeMessageEventData) => {
      earlyMessages.push(data);
    };
    const captureClosed = (data: ProcessClosedEventData) => {
      earlyClosed.push(data);
    };
    const captureError = (data: { streamingId: string; error: string }) => {
      earlyErrors.push(data);
    };

    this.client.on('claude-message', captureMessage);
    this.client.on('process-closed', captureClosed);
    this.client.on('process-error', captureError);

    try {
      // Spawn optimistically — returns streamingId immediately,
      // system init arrives via events. Keep the early capture listeners
      // attached until the ProcessHandle listeners are installed so fast
      // child output cannot fall between the optimistic response and stdout
      // subscription.
      const { streamingId } = await this.client.startConversationOptimistic(daemonConfig);
      this.managedStreamingIds.add(streamingId);
      logger.info('Daemon spawn returned', { streamingId });

      return createProcessHandle(this.client, streamingId, {
        earlyMessages: earlyMessages.filter((data) => data.streamingId === streamingId),
        earlyClosed: earlyClosed.find((data) => data.streamingId === streamingId),
        earlyError: earlyErrors.find((data) => data.streamingId === streamingId),
      });
    } finally {
      this.client.removeListener('claude-message', captureMessage);
      this.client.removeListener('process-closed', captureClosed);
      this.client.removeListener('process-error', captureError);
    }
  }
}

function createProcessHandle(
  client: ProcessManagerClient,
  streamingId: string,
  initial?: {
    earlyMessages?: ClaudeMessageEventData[];
    earlyClosed?: ProcessClosedEventData;
    earlyError?: { streamingId: string; error: string };
  },
): ProcessHandle {
  let alive = true;
  // Reads the CLI's receipts for steered messages off the same frames the
  // harness parses; every frame, buffered or live, passes through it first.
  const tracker = new ClaudeSteerTracker(streamingId);

  const exitResolvers: {
    resolve: (value: { code: number; signal?: string; lost?: boolean }) => void;
  }[] = [];

  const exited = new Promise<{ code: number; signal?: string; lost?: boolean }>((resolve) => {
    exitResolvers.push({ resolve });
  });

  // stdout: yields JSON lines from daemon claude-message events
  const stdout = createStdoutIterable(
    client,
    streamingId,
    () => !alive,
    (message) => tracker.observe(message),
    initial?.earlyMessages?.map((data) => data.message),
  );

  // Listen for process-closed to mark dead and resolve exited
  const onProcessClosed = (data: ProcessClosedEventData) => {
    if (data.streamingId !== streamingId) return;
    alive = false;
    tracker.close();
    stdout.terminate();
    client.removeListener('process-closed', onProcessClosed);
    client.removeListener('process-error', onProcessError);
    client.removeListener('daemon-disconnected', onDaemonDisconnected);
    for (const r of exitResolvers) {
      r.resolve({ code: data.code ?? 1 });
    }
  };

  const onProcessError = (data: { streamingId: string; error: string }) => {
    if (data.streamingId !== streamingId) return;
    alive = false;
    tracker.close();
    stdout.terminate();
    client.removeListener('process-closed', onProcessClosed);
    client.removeListener('process-error', onProcessError);
    client.removeListener('daemon-disconnected', onDaemonDisconnected);
    for (const r of exitResolvers) {
      r.resolve({ code: 1 });
    }
  };

  // The daemon went away, and this process with it; no process-closed will
  // come. Without this the session keeps writing to a process nobody runs.
  const onDaemonDisconnected = () => {
    if (!alive) return;
    alive = false;
    tracker.close();
    stdout.terminate();
    client.removeListener('process-closed', onProcessClosed);
    client.removeListener('process-error', onProcessError);
    client.removeListener('daemon-disconnected', onDaemonDisconnected);
    for (const r of exitResolvers) {
      r.resolve({ code: 1, lost: true });
    }
  };

  client.on('process-closed', onProcessClosed);
  client.on('process-error', onProcessError);
  client.on('daemon-disconnected', onDaemonDisconnected);

  if (initial?.earlyClosed) {
    onProcessClosed(initial.earlyClosed);
  } else if (initial?.earlyError) {
    onProcessError(initial.earlyError);
  }

  return {
    stdout,
    write(input: string, extra?: Record<string, unknown>) {
      if (!alive) return;
      // Input arrives with trailing \n from SessionManager.send(), strip it for daemon
      const trimmed = input.endsWith('\n') ? input.slice(0, -1) : input;
      // Composer attachments ride the same `extra` bag the SDK adapter reads.
      // The CLI's stdin format is the same Anthropic message shape the SDK
      // sends, so image/document blocks go over the wire unchanged.
      const parsed = parseAttachmentBlocks(extra?.attachments);
      if (!parsed.ok) {
        logger.error('Dropping malformed attachments on daemon write', new Error(parsed.error), { streamingId });
      }
      const attachments = parsed.ok ? parsed.blocks : [];
      // Claude CLI expects --input-format stream-json: each stdin line must be
      // a valid JSON object matching the Anthropic message format.
      const stdinMessage = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: buildUserContent(trimmed, attachments),
        },
      });
      client.sendStdinMessage(streamingId, stdinMessage).catch((err) => {
        logger.error('Failed to write to daemon', { streamingId, error: String(err) });
      });
    },
    /**
     * Into the running turn, at the CLI's next input point, without touching
     * the tool it is in. The daemon acknowledging the stdin write is not the
     * CLI acknowledging receipt: only its `command_lifecycle` frame is, and
     * the tracker waits for that. A failed or lost daemon write after the
     * hand-off is `uncertain`, never a licence to send again.
     */
    steer(request: SteerRequest): Promise<SteerOutcome> {
      if (!alive) return Promise.resolve({ status: 'rejected', reason: 'Claude session is not running' });
      return tracker.steer(request, (message) => {
        client.sendStdinMessage(streamingId, JSON.stringify(message)).then((ok) => {
          if (!ok) logger.warn('Daemon refused the steered write; awaiting the CLI receipt decides', { streamingId, deliveryId: request.deliveryId });
        }).catch((err) => {
          logger.error('Failed to write steered message to daemon', { streamingId, deliveryId: request.deliveryId, error: String(err) });
        });
      });
    },
    signal(sig: NodeJS.Signals) {
      if (!alive) return;
      switch (sig) {
        case 'SIGINT':
          // "Cancel this turn" is the CLI's stdin interrupt request, not a
          // signal: CLI 2.1.282 ends the turn on SIGINT and then exits, so a
          // message written after the cancelled turn was lost (2026-09-25).
          // An unanswered request still escalates to SIGTERM in stop().
          client.sendStdinMessage(streamingId, JSON.stringify({
            type: 'control_request',
            request_id: `interrupt-${randomUUID()}`,
            request: { subtype: 'interrupt' },
          })).then((ok) => {
            if (!ok) logger.warn('Daemon refused the interrupt request', { streamingId });
          }).catch((err) => {
            logger.warn('Interrupt failed', { streamingId, error: String(err) });
          });
          break;
        case 'SIGTERM':
          client.stopConversation(streamingId).catch((err) => {
            logger.warn('Stop failed', { streamingId, error: String(err) });
          });
          break;
        case 'SIGKILL':
          client.forceKillConversation(streamingId).catch((err) => {
            logger.warn('Force kill failed', { streamingId, error: String(err) });
          });
          break;
        default:
          logger.warn('Unsupported signal', { sig, streamingId });
      }
    },
    exited,
    get alive() {
      return alive;
    },
    pid: undefined,
    processId: streamingId,
  };
}

/**
 * Creates an AsyncIterable<string> from daemon claude-message events.
 * Each yielded string is a JSON line (the raw CLI event re-serialized).
 */
function createStdoutIterable(
  client: ProcessManagerClient,
  streamingId: string,
  isDead: () => boolean,
  observe: (message: unknown) => void,
  initialMessages: unknown[] = [],
): AsyncIterable<string> & { terminate: () => void } {
  const queue: string[] = [];
  let waiter: (() => void) | null = null;
  let terminated = false;

  const push = (message: unknown): void => {
    observe(message);
    // Re-serialize the raw CLI JSON event as a line for the harness parser
    queue.push(JSON.stringify(message));
  };
  for (const message of initialMessages) push(message);

  const handler = (data: ClaudeMessageEventData) => {
    if (data.streamingId !== streamingId) return;
    push(data.message);
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  };

  client.on('claude-message', handler);

  const terminate = () => {
    if (terminated) return;
    terminated = true;
    client.removeListener('claude-message', handler);
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  };

  const iterable: AsyncIterable<string> & { terminate: () => void } = {
    terminate,
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<string>> {
          while (queue.length === 0 && !terminated && !isDead()) {
            await new Promise<void>((resolve) => {
              waiter = resolve;
            });
          }
          if (queue.length > 0) {
            return { value: queue.shift()!, done: false };
          }
          return { value: undefined as unknown as string, done: true };
        },
      };
    },
  };

  return iterable;
}
