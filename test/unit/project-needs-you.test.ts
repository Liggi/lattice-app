/**
 * Project Needs you: candidates come from the project record, Jev scores each
 * once per change in the background, and the project lights when any thread's
 * act × (1 − parked) is over the bar.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectOpenThread } from '../../src/types/project-state.js';

let open: ProjectOpenThread[] = [];
let priority: { text: string } | null = null;
let maxSeq = 1;
let workerEvents: { type: string; timestamp: number; data: unknown }[] = [];
let userSent: { timestamp: number }[] = [];
const judgeNouls = vi.fn();

vi.mock('../../src/services/sessions/project-state.js', () => ({ readProjectState: () => ({ open, priority, now: null }) }));
vi.mock('../../src/session-history/repository.js', () => ({ getEvents: () => workerEvents, iterateEventsNewestFirst: () => userSent[Symbol.iterator]() }));
vi.mock('../../src/harness/event-message-reader.js', () => ({ getEventStorage: () => ({ maxSeq: () => maxSeq }) }));
vi.mock('../../src/services/infrastructure/typesafe-client.js', () => ({ judgeNouls: (...args: unknown[]) => judgeNouls(...args) }));
vi.mock('../../src/services/infrastructure/database-provider.js', () => ({
  DatabaseProvider: { getInstance: () => ({ getDb: () => ({ prepare: () => ({ get: (id: string) => ({ coordinator: id === 'conv-p' ? 1 : 0 }) }) }) }) },
}));
vi.mock('../../src/services/sessions/session-info-service.js', () => ({
  SessionInfoService: { getInstance: () => ({ getSessionInfoSync: () => ({ custom_name: 'Project' }) }) },
}));
vi.mock('../../src/services/user-profile.js', () => ({ userName: () => 'Alex' }));

const { projectNeedsYou, projectWorkingOn, projectWorkerTasks, __resetNeedsYouForTests } = await import('../../src/services/sessions/project-needs-you.js');

function thread(seq: number, overrides: Partial<ProjectOpenThread> = {}): ProjectOpenThread {
  return {
    seq, at: 0, text: `thread ${seq}`, summary: null, evidence: [], owner: { kind: 'coordinator' } as ProjectOpenThread['owner'],
    nextAction: null, waitingOn: { kind: 'decision', text: `decide ${seq}` } as ProjectOpenThread['waitingOn'],
    workers: [], events: [], updatedAt: 1000, waitingSince: 500, ...overrides,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('projectNeedsYou', () => {
  beforeEach(() => {
    __resetNeedsYouForTests();
    judgeNouls.mockReset();
    maxSeq = 1;
  });

  it('is null for a conversation that is not a project', () => {
    expect(projectNeedsYou('conv-s')).toBeNull();
  });

  it("gives the project's Working on line without its thread references", () => {
    priority = { text: 'First live-written scene in game, then the agent-played fresh game (thread [948])' };
    expect(projectWorkingOn('conv-p')).toBe('First live-written scene in game, then the agent-played fresh game');
    expect(projectWorkingOn('conv-s')).toBeNull();
    priority = null;
  });

  it('names each worker by the task it was dispatched on, as the right panel does', () => {
    workerEvents = [{ type: 'worker:started', timestamp: 1, data: { worker: 'conv-w', provider: 'claude', task: 'Screenshot every sidebar tooltip' } }];
    expect(projectWorkerTasks('conv-p')).toEqual({ 'conv-w': 'Screenshot every sidebar tooltip' });
    expect(projectWorkerTasks('conv-s')).toBeNull();
    workerEvents = [];
  });

  it('scores candidates in the background and lights only those over the bar', async () => {
    open = [
      thread(1),
      thread(2),
      thread(3, { waitingOn: { kind: 'worker', text: 'a worker' } as ProjectOpenThread['waitingOn'] }),
    ];
    judgeNouls.mockImplementation(async (state: string) => (state.includes('thread 1')
      ? { nouls: { act: 0.9, parked: 0.1 } }
      : { nouls: { act: 0.8, parked: 0.5 } }));

    expect(projectNeedsYou('conv-p')).toEqual([]);
    await settle();
    expect(judgeNouls).toHaveBeenCalledTimes(2);
    expect(projectNeedsYou('conv-p')).toEqual([{ seq: 1, text: 'decide 1', thread: 'thread 1', since: 500, score: 0.81 }]);
    expect(judgeNouls).toHaveBeenCalledTimes(2);
  });

  it('keeps a score until the thread changes', async () => {
    open = [thread(1)];
    judgeNouls.mockResolvedValue({ nouls: { act: 0.9, parked: 0.1 } });
    projectNeedsYou('conv-p');
    await settle();
    projectNeedsYou('conv-p');
    expect(judgeNouls).toHaveBeenCalledTimes(1);

    open = [thread(1, { updatedAt: 2000 })];
    maxSeq = 2;
    judgeNouls.mockResolvedValue({ nouls: { act: 0.9, parked: 0.9 } });
    projectNeedsYou('conv-p');
    await settle();
    expect(judgeNouls).toHaveBeenCalledTimes(2);
    expect(projectNeedsYou('conv-p')).toEqual([]);
  });

  it('treats an ask as answered once the user has written to the project after it started waiting', async () => {
    open = [thread(1, { waitingSince: 500 }), thread(2, { waitingSince: 900 })];
    judgeNouls.mockResolvedValue({ nouls: { act: 0.9, parked: 0.1 } });
    userSent = [{ timestamp: 700 }];
    projectNeedsYou('conv-p');
    await settle();
    expect(projectNeedsYou('conv-p')?.map(item => item.seq)).toEqual([2]);
    expect(judgeNouls).toHaveBeenCalledTimes(1);
    userSent = [];
  });
});
