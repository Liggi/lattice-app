/**
 * Two standing rules are only shared behaviour if every coordinator gets them,
 * not just a freshly created one. A coordinator picked up into a new
 * conversation is built here; a coordinator that compacted mid-project has its
 * preamble rebuilt into the restore block. Both paths are checked, because a
 * rule that reaches only one of them is a rule that lapses partway through a
 * project.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawEvent } from '../../src/session-history/types.js';

let storedEvents = new Map<string, RawEvent[]>();
let nextSeq = 1000;

vi.mock('../../src/harness/setup.js', () => ({
  getHarnessSessionManager: () => ({ inspect: () => null }),
}));
vi.mock('../../src/session-history/repository.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...(await import('./fake-event-reads.js')).fakeEventReads((conversationId) => storedEvents.get(conversationId) ?? []),
}));

const { DatabaseProvider } = await import('../../src/services/infrastructure/database-provider.js');
const { ConversationService } = await import('../../src/services/sessions/conversation-service.js');
const { SessionInfoService } = await import('../../src/services/sessions/session-info-service.js');
const { buildCoordinatorPreamble, buildWorkerPreamble, latticeCli } =
  await import('../../src/services/sessions/pickup-prompts.js');
const { buildCoordinatorRestore } = await import('../../src/services/sessions/context-compaction.js');

/** The turn-ending rule and the archive rule, by the clause each turns on. */
const ENDING_A_TURN = 'not when you have';
const REDISPATCH_CLEARS_ARCHIVE = 'Finished workers are archived for you';

function push(conversationId: string, type: string, data: unknown): void {
  nextSeq += 1;
  storedEvents.set(conversationId, [
    ...(storedEvents.get(conversationId) ?? []),
    { conversationId, seq: nextSeq, runId: 'run-1', timestamp: nextSeq, type, data, meta: null } as RawEvent,
  ]);
}

let coordinator: string;

beforeEach(async () => {
  storedEvents = new Map();
  nextSeq = 1000;
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
  await new SessionInfoService(':memory:').initialize();
  coordinator = ConversationService.getInstance().createConversation({
    workingDirectory: '/tmp', provider: 'codex', providerSessionId: 'p-front', coordinator: true,
  }).conversationId;
});
afterEach(() => {
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
});

describe('the rules a coordinator works by', () => {
  it('are in the preamble a coordinator starts with', () => {
    const preamble = buildCoordinatorPreamble({ conversationId: coordinator, workingDirectory: '/tmp', cli: latticeCli() });
    expect(preamble).toContain(ENDING_A_TURN);
    expect(preamble).toContain(REDISPATCH_CLEARS_ARCHIVE);
  });

  it('come back to a coordinator that compacted mid-project', () => {
    push(coordinator, 'input:sent', { text: 'go' });
    push(coordinator, 'turn:end', { compact: true, trigger: 'auto' });

    const restored = buildCoordinatorRestore(coordinator);
    expect(restored).toContain(ENDING_A_TURN);
    expect(restored).toContain(REDISPATCH_CLEARS_ARCHIVE);
  });

  it('stay out of a worker preamble, which reports rather than dispatches', () => {
    const worker = buildWorkerPreamble({
      conversationId: 'conv-worker', parentConversationId: coordinator, cli: latticeCli(),
    });
    expect(worker).not.toContain(ENDING_A_TURN);
    expect(worker).not.toContain(REDISPATCH_CLEARS_ARCHIVE);
  });
});
