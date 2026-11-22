/**
 * Coordinator profiles: a coordinator records the profile it was created on,
 * and its routing text, chief of staff and model come from that record, so a
 * compaction rebuilds the same preamble and a coordinator from before
 * profiles keeps the fixed Opus routing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawEvent } from '../../src/session-history/types.js';
import type { CoordinatorProfile } from '../../src/constants/coordinator-profiles.js';

let storedEvents = new Map<string, RawEvent[]>();
const config: { coordinatorProfiles?: Record<string, CoordinatorProfile>; coordinator?: { defaultProfile?: string } } = {};

vi.mock('../../src/harness/setup.js', () => ({
  getHarnessSessionManager: () => ({ inspect: () => null }),
}));
vi.mock('../../src/session-history/repository.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...(await import('./fake-event-reads.js')).fakeEventReads((conversationId) => storedEvents.get(conversationId) ?? []),
}));
vi.mock('../../src/services/sessions/coordinator-defaults.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  coordinatorProfileSettings: () => config,
}));

const { DatabaseProvider } = await import('../../src/services/infrastructure/database-provider.js');
const { ConversationService } = await import('../../src/services/sessions/conversation-service.js');
const { SessionInfoService } = await import('../../src/services/sessions/session-info-service.js');
const { buildCoordinatorPreamble, buildWorkerPreamble, latticeCli } = await import('../../src/services/sessions/pickup-prompts.js');
const { buildCoordinatorRestore } = await import('../../src/services/sessions/context-compaction.js');
const { effortProblem, findProfile, profileForNewCoordinator, profileForRecorded } =
  await import('../../src/constants/coordinator-profiles.js');
const { DaemonProcessAdapter } = await import('../../src/harness/daemon-process-adapter.js');
const { ProcessDaemon } = await import('../../src/process-daemon/process-daemon.js');

const NEON_FRONT: CoordinatorProfile = {
  front: { provider: 'antigravity', model: 'agy:gemini-4-neon-high' },
  chiefOfStaff: { provider: 'claude', model: 'claude-fable-5-2', effort: 'high', label: 'Fable 5.2' },
  workers: [
    { label: 'Opus', provider: 'claude', model: 'claude-opus-5-5', when: 'the usual choice for {user}\'s work.' },
    { label: 'Fable', provider: 'claude', model: 'claude-fable-5-2', effort: 'high', when: 'when the evidence shows a hard design problem.' },
  ],
};
const FIXED_ROUTING = 'Do not dispatch Fable.';

function push(conversationId: string, type: string, data: unknown, seq: number): void {
  storedEvents.set(conversationId, [
    ...(storedEvents.get(conversationId) ?? []),
    { conversationId, seq, runId: 'run-1', timestamp: seq, type, data, meta: null } as RawEvent,
  ]);
}

beforeEach(async () => {
  storedEvents = new Map();
  config.coordinatorProfiles = { 'neon-front': NEON_FRONT };
  delete config.coordinator;
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
  await new SessionInfoService(':memory:').initialize();
});
afterEach(() => {
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
});

describe('choosing a profile', () => {
  it('starts a new coordinator on "opus" unless a profile or a configured default says otherwise', () => {
    expect(profileForNewCoordinator(undefined, config)).toMatchObject({ name: 'opus' });
    config.coordinator = { defaultProfile: 'neon-front' };
    expect(profileForNewCoordinator(undefined, config)).toMatchObject({ name: 'neon-front' });
    expect(profileForNewCoordinator('opus', config)).toMatchObject({ name: 'opus' });
  });

  it('refuses a profile nobody defined, naming the ones there are', () => {
    expect(profileForNewCoordinator('fable-front', config)).toEqual({ error: expect.stringContaining('known: opus, neon-front') });
  });

  it('keeps "opus" built in even when config defines one', () => {
    config.coordinatorProfiles = { opus: { workers: [{ label: 'X', provider: 'claude', model: 'x', when: 'always' }] } };
    expect(findProfile('opus', config)?.profile.workers).toBeUndefined();
  });

  it('reads a coordinator with no recorded profile as "opus", and says so when a recorded one is gone', () => {
    expect(profileForRecorded(null, config).name).toBe('opus');
    expect(profileForRecorded('gone', config)).toMatchObject({ name: 'opus', missing: 'gone' });
  });

  it('takes Claude --effort levels and leaves Antigravity to its model id', () => {
    expect(effortProblem('claude', 'high')).toBeNull();
    expect(effortProblem('claude', 'minimal')).toContain('low, medium, high, xhigh, max');
    expect(effortProblem('antigravity', 'high')).toContain('model id');
  });
});

describe('the routing front is given', () => {
  const base = { conversationId: 'conv-front', workingDirectory: '/tmp', cli: latticeCli() };

  it('is the fixed Opus routing, word for word, on "opus" and with no profile', () => {
    const none = buildCoordinatorPreamble(base);
    const opus = buildCoordinatorPreamble({ ...base, profile: profileForRecorded('opus', config) });
    expect(opus).toBe(none);
    expect(none).toContain(FIXED_ROUTING);
    expect(none).not.toContain('chief of staff');
  });

  it('comes from the profile\'s workers, with the chief of staff and how to reach it', () => {
    const text = buildCoordinatorPreamble({ ...base, profile: profileForRecorded('neon-front', config) });
    expect(text).not.toContain(FIXED_ROUTING);
    expect(text).toContain('This project is on the "neon-front" profile');
    expect(text).toContain('Opus (`--provider claude --model claude-opus-5-5`): the usual choice for');
    expect(text).toContain('Fable (`--provider claude --model claude-fable-5-2 --reasoning-effort high`)');
    expect(text).not.toContain('{user}');
    expect(text).toContain('one standing Fable 5.2 session');
    expect(text).toContain(`session consult --from conv-front`);
  });

  it('is the same after a compaction, from the profile recorded on the coordinator', () => {
    const front = ConversationService.getInstance().createConversation({
      workingDirectory: '/tmp', provider: 'antigravity', providerSessionId: 'p-front', coordinator: true,
      model: 'agy:gemini-4-neon-high', profile: 'neon-front',
    }).conversationId;
    push(front, 'input:sent', { text: 'go' }, 1);
    push(front, 'turn:end', { compact: true, trigger: 'manual' }, 2);
    const restored = buildCoordinatorRestore(front);
    expect(restored).toContain('This project is on the "neon-front" profile');
    expect(restored).toContain(`session consult --from ${front}`);
    expect(restored).not.toContain(FIXED_ROUTING);
  });

  it('stays the fixed routing after a compaction for a coordinator from before profiles', () => {
    const front = ConversationService.getInstance().createConversation({
      workingDirectory: '/tmp', provider: 'claude', providerSessionId: 'p-old', coordinator: true,
    }).conversationId;
    push(front, 'input:sent', { text: 'go' }, 1);
    push(front, 'turn:end', { compact: true, trigger: 'manual' }, 2);
    expect(buildCoordinatorRestore(front)).toContain(FIXED_ROUTING);
  });
});

describe('the chief of staff', () => {
  it('is told its role, which an ordinary worker is not', () => {
    const input = { conversationId: 'conv-cos', parentConversationId: 'conv-front', parentProvider: null, parentModel: null, workingDirectory: '/tmp', cli: latticeCli() };
    expect(buildWorkerPreamble({ ...input, chiefOfStaff: true })).toContain("you are front's chief of staff");
    expect(buildWorkerPreamble(input)).not.toContain('chief of staff');
  });

  it('is found by its coordinator, so a second consult reaches the same session', () => {
    const service = ConversationService.getInstance();
    const front = service.createConversation({ workingDirectory: '/tmp', provider: 'antigravity', providerSessionId: 'p-f', coordinator: true, profile: 'neon-front' }).conversationId;
    expect(service.findWorkerWithRole(front, 'chief-of-staff')).toBeNull();
    service.createConversation({ workingDirectory: '/tmp', provider: 'claude', providerSessionId: 'p-w', pickedUpFrom: front });
    const chief = service.createConversation({ workingDirectory: '/tmp', provider: 'claude', providerSessionId: 'p-c', pickedUpFrom: front, workerRole: 'chief-of-staff', reasoningEffort: 'high' }).conversationId;
    expect(service.findWorkerWithRole(front, 'chief-of-staff')).toBe(chief);
    expect(service.getWorkerRole(chief)).toBe('chief-of-staff');
    expect(service.getProfile(front)).toBe('neon-front');
  });
});

describe('Claude effort', () => {
  it('reaches the daemon on every spawn of a conversation that recorded one', async () => {
    const configs: Array<{ effort?: string }> = [];
    const client = {
      on: () => undefined,
      removeListener: () => undefined,
      startConversationOptimistic: async (c: { effort?: string }) => { configs.push(c); throw new Error('stop here'); },
    };
    const adapter = new DaemonProcessAdapter(client as never, () => false, (id) => (id === 'conv-fable' ? 'high' : undefined));
    await expect(adapter.spawn({ prompt: 'hi', extra: { sessionId: 'conv-fable' } })).rejects.toThrow('stop here');
    await expect(adapter.spawn({ prompt: 'hi', extra: { sessionId: 'conv-opus' } })).rejects.toThrow('stop here');
    expect(configs.map((c) => c.effort)).toEqual(['high', undefined]);
  });

  it('becomes --effort on a fresh start and on a resume, and is absent when none was set', () => {
    const daemon = new ProcessDaemon({ socketPath: `/tmp/test-daemon-${Math.random()}.sock`, claudeExecutablePath: '/usr/bin/true' }) as unknown as {
      buildStartArgs: (c: unknown) => string[];
      buildResumeArgs: (c: unknown) => string[];
    };
    const start = daemon.buildStartArgs({ workingDirectory: '/tmp', initialPrompt: 'hi', model: 'claude-fable-5-2', effort: 'high' });
    expect(start.slice(start.indexOf('--effort'), start.indexOf('--effort') + 2)).toEqual(['--effort', 'high']);
    const resume = daemon.buildResumeArgs({ sessionId: 's', message: 'hi', streamingId: 'x', model: 'claude-fable-5-2', effort: 'high' });
    expect(resume.slice(resume.indexOf('--effort'), resume.indexOf('--effort') + 2)).toEqual(['--effort', 'high']);
    expect(daemon.buildStartArgs({ workingDirectory: '/tmp', initialPrompt: 'hi', model: 'claude-opus-5-5' })).not.toContain('--effort');
  });
});
