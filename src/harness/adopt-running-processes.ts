/**
 * Taking over the Claude processes a previous server left running.
 *
 * The daemon outlives a server restart, and so do the processes it runs. At
 * boot, before the recovery sweep closes interrupted sessions, each process
 * the daemon lists for a Claude conversation is attached: the harness takes
 * it over as the session's live process, the daemon replays what it printed
 * while no server was listening, and its turn goes on as if the restart had
 * not happened. A session taken over is in memory, so the sweep leaves it
 * alone and it gets no carry-on note. A process that cannot be taken over is
 * left out of the returned set and is stopped by the caller.
 */

import type { SessionManager, StartConfig } from '@liggi/agent-ui-harness/server';
import type { ActiveSession } from '../process-daemon/types.js';
import type { DaemonProcessAdapter } from './daemon-process-adapter.js';
import type { SqliteEventStorageAdapter } from './sqlite-event-storage.js';
import type { ActiveConversationRegistry } from '../services/process/active-conversation-registry.js';
import { ConversationService } from '../services/sessions/conversation-service.js';
import { createLogger } from '../services/infrastructure/logger.js';

const logger = createLogger('AdoptRunningProcesses');

type RunReadyStore = Pick<SqliteEventStorageAdapter, 'findLatestRunReady'>;

/** Busy processes first, then idle ones, then ones that exited while no server listened. */
function adoptionOrder(p: ActiveSession): number {
  if (p.exited) return 2;
  return p.isIdle ? 1 : 0;
}

/**
 * What the process advertised on its last system/init, from the run:ready the
 * previous server stored. The CLI sends system/init once per turn, so without
 * this a process taken over mid-turn could not take a message into that turn
 * until its next one started.
 */
function storedCapabilities(storage: RunReadyStore, sessionId: string, runId: string): string[] | null {
  const ready = storage.findLatestRunReady(sessionId);
  if (!ready || ready.runId !== runId) return null;
  const capabilities = (ready.data as { capabilities?: unknown }).capabilities;
  return Array.isArray(capabilities) ? capabilities as string[] : null;
}

function permissionModeOf(config: StartConfig | null): string {
  const arg = config?.args?.find((a) => a.startsWith('--permission-mode='));
  return arg ? arg.slice('--permission-mode='.length) : 'default';
}

/** Returns the streamingIds taken over. */
export function adoptRunningProcesses(
  running: readonly ActiveSession[],
  adapter: DaemonProcessAdapter,
  sessionManager: SessionManager,
  registry: ActiveConversationRegistry,
  storage: RunReadyStore,
): Set<string> {
  const adopted = new Set<string>();
  const conversations = ConversationService.getInstance();
  for (const proc of [...running].sort((a, b) => adoptionOrder(a) - adoptionOrder(b))) {
    const conversationId = proc.conversationId;
    if (!conversationId || sessionManager.hasSession(conversationId)) continue;
    const conversation = conversations.getConversation(conversationId);
    const latest = conversation?.segments[conversation.segments.length - 1];
    if (!conversation || !latest || latest.provider !== 'claude') continue;

    const { handle, attached } = adapter.attach(proc.streamingId);
    const taken = sessionManager.adopt(conversationId, handle);
    void attached;
    if (!taken) {
      handle.fail('Session was not taken over');
      continue;
    }
    const capabilities = storedCapabilities(storage, conversationId, taken.runId);
    if (capabilities) handle.learnCapabilities(capabilities);
    registry.register({
      conversationId,
      segment: {
        segmentId: latest.segmentId,
        provider: latest.provider,
        providerSessionId: latest.providerSessionId,
        model: latest.model ?? undefined,
        transitionReason: 'resume',
      },
      run: {
        streamingId: proc.streamingId,
        runVersion: registry.allocateRunVersion(conversationId),
        startedAt: new Date().toISOString(),
      },
      workingDirectory: conversation.workingDirectory,
      permissionMode: permissionModeOf(taken.lastConfig),
    });
    adopted.add(proc.streamingId);
    logger.info('Took over a process the previous server left running', {
      conversationId,
      streamingId: proc.streamingId,
      idle: proc.isIdle,
      exited: proc.exited,
    });
  }
  return adopted;
}
