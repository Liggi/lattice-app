/**
 * Dismissing a thread from the panel is the user's call to stop that work.
 * What has to happen together: the thread is parked as theirs, the worker
 * carrying it mid-turn is stopped (an idle one is left alone), the card the
 * coordinator asked about it closes, and the coordinator is handed one line
 * saying all of that. Bringing it back unparks it and says so.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { foldProjectState, PROJECT_NOTED_EVENT, type ProjectEventLike, type ProjectNotedData } from '../../src/types/project-state.js';

const log: ProjectEventLike[] = [];
const custom: Array<{ session: string; type: string; data: unknown }> = [];
const inbox: Array<{ sessionId: string; source: string; text: string }> = [];
const interrupted: string[] = [];
const status: Record<string, { processAlive: boolean; status: string }> = {};

function append(data: Partial<ProjectNotedData>): number {
  const seq = log.length + 1;
  log.push({ seq, type: PROJECT_NOTED_EVENT, timestamp: seq, data: { text: '', by: 'coordinator', ...data } });
  return seq;
}

vi.mock('../../src/harness/setup.js', () => ({
  getHarnessSessionManager: () => ({ inspect: (id: string) => status[id] ?? null }),
}));
vi.mock('../../src/harness/harness-custom-events.js', () => ({
  appendCustomHarnessEvent: (_m: unknown, session: string, type: string, data: unknown) => { custom.push({ session, type, data }); return true; },
}));
vi.mock('../../src/services/sessions/project-state.js', () => ({
  readProjectState: () => foldProjectState(log),
  appendProjectNote: (_c: string, data: ProjectNotedData) => append(data),
}));
vi.mock('../../src/services/sessions/worker-events.js', () => ({
  readWorkerStates: () => [
    { worker: 'conv-busy', thread: 1 },
    { worker: 'conv-idle', thread: 1 },
    { worker: 'conv-other', thread: 2 },
  ],
}));
vi.mock('../../src/services/sessions/open-decision.js', () => ({
  decisionsIn: () => new Map([
    ['card-1', { asked: { id: 'card-1', question: 'Publish?', options: [], thread: 1 }, answer: null, read: false, replaced: false, settled: false, latest: true, dismissed: false }],
  ]),
}));
vi.mock('../../src/services/sessions/session-inbox.js', () => ({
  enqueueInboxItem: (item: { sessionId: string; source: string; text: string }) => { inbox.push(item); return `inbox-${inbox.length}`; },
}));
vi.mock('../../src/services/sessions/immediate-delivery.js', () => ({ handOverNow: async () => undefined }));
vi.mock('../../src/services/sessions/turn-interrupt.js', () => ({
  interruptTurn: async (_m: unknown, id: string) => { interrupted.push(id); return { ended: true, via: 'turn:end', stopSeq: null }; },
}));
vi.mock('../../src/services/user-profile.js', () => ({ UserName: () => 'Jason', userName: () => 'Jason' }));

const { dismissThread, restoreThread } = await import('../../src/services/sessions/thread-dismissal.js');

beforeEach(() => {
  log.length = 0;
  custom.length = 0;
  inbox.length = 0;
  interrupted.length = 0;
  append({ kind: 'open', text: 'Release 0.4.1 [23830]', label: 'Publish 0.4.1?', owner: { kind: 'user' } });
  append({ kind: 'open', text: 'Something else' });
  status['conv-busy'] = { processAlive: true, status: 'streaming' };
  status['conv-idle'] = { processAlive: true, status: 'idle' };
  status['conv-other'] = { processAlive: true, status: 'streaming' };
});

describe('dismissThread', () => {
  it('parks the thread as the user\'s call, under the name the panel showed', async () => {
    await dismissThread('conv-coord', 1);
    const thread = foldProjectState(log).open.find((candidate) => candidate.seq === 1);
    expect(thread?.parked?.by).toBe('user');
    expect((log.at(-1)!.data as ProjectNotedData).label).toBe('Publish 0.4.1?');
  });

  it('stops only the worker carrying it mid-turn', async () => {
    const { stopped } = await dismissThread('conv-coord', 1);
    expect(interrupted).toEqual(['conv-busy']);
    expect(stopped).toEqual(['conv-busy']);
  });

  it('closes the card asked about it and tells the coordinator in one attributed line', async () => {
    await dismissThread('conv-coord', 1);
    expect(custom).toEqual([{ session: 'conv-coord', type: 'decision:dismissed', data: { id: 'card-1' } }]);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].source).toBe('dismissal');
    expect(inbox[0].text).toBe('Jason dismissed thread [1] "Publish 0.4.1?" from their panel. It is parked as their call. Its worker conv-busy was stopped. Stop working on it and do not bring it back; they can restore it from Parked themselves.');
  });

  it('refuses a thread that is already parked', async () => {
    await dismissThread('conv-coord', 1);
    await expect(dismissThread('conv-coord', 1)).rejects.toThrow('already parked');
  });
});

describe('restoreThread', () => {
  it('unparks it and tells the coordinator', async () => {
    await dismissThread('conv-coord', 1);
    await restoreThread('conv-coord', 1);
    expect(foldProjectState(log).open.find((candidate) => candidate.seq === 1)?.parked).toBeUndefined();
    expect(inbox.at(-1)?.text).toContain('Jason brought thread [1] "Publish 0.4.1?" back from Parked');
  });
});
