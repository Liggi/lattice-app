import { describe, it, expect } from 'vitest';
import { reapIdleSessions, IDLE_REAP_AFTER_MS } from '@/services/sessions/idle-session-reaper.js';
import type { SessionInfoService } from '@/services/sessions/session-info-service.js';

const NOW = 1_800_000_000_000;
const OLD = NOW - IDLE_REAP_AFTER_MS - 60_000;
const RECENT = NOW - 60_000;

type EventShape = { type: string; timestamp: number; data?: unknown };

function idleEvents(lastTimestamp: number): EventShape[] {
  return [
    { type: 'run:start', timestamp: lastTimestamp - 30_000, data: {} },
    { type: 'run:ready', timestamp: lastTimestamp - 29_000, data: {} },
    { type: 'input:sent', timestamp: lastTimestamp - 28_000, data: {} },
    { type: 'content', timestamp: lastTimestamp - 10_000, data: {} },
    { type: 'turn:end', timestamp: lastTimestamp, data: {} },
  ];
}

function streamingEvents(lastTimestamp: number): EventShape[] {
  return [
    { type: 'run:start', timestamp: lastTimestamp - 30_000, data: {} },
    { type: 'run:ready', timestamp: lastTimestamp - 29_000, data: {} },
    { type: 'input:sent', timestamp: lastTimestamp - 1_000, data: {} },
    { type: 'content', timestamp: lastTimestamp, data: {} },
  ];
}

function makeSessionInfoService(teamBySessionId: Record<string, string | null> = {}): SessionInfoService {
  return {
    getMergedSessionInfo: (conversationId: string) => {
      const team = teamBySessionId[conversationId];
      if (team === undefined) return null;
      return { team_name: team } as ReturnType<SessionInfoService['getMergedSessionInfo']>;
    },
  } as unknown as SessionInfoService;
}

function makeDeps(eventsBySession: Record<string, EventShape[]>): {
  deps: Parameters<typeof reapIdleSessions>[2];
  stopped: string[];
} {
  const stopped: string[] = [];
  return {
    stopped,
    deps: {
      manager: {
        getSessionIds: () => Object.keys(eventsBySession),
        stop: async (sessionId: string) => { stopped.push(sessionId); },
      },
      storage: {
        readStatusWindow: (sessionId: string) =>
          (eventsBySession[sessionId] ?? []) as ReturnType<
            NonNullable<NonNullable<Parameters<typeof reapIdleSessions>[2]['storage']>>['readStatusWindow']
          >,
      },
      getLatestSegmentProviderSessionId: () => undefined,
    },
  };
}

describe('reapIdleSessions', () => {
  it('reaps a session idle past the threshold', async () => {
    const { deps, stopped } = makeDeps({ 'conv-old-idle': idleEvents(OLD) });
    const result = await reapIdleSessions(makeSessionInfoService(), NOW, deps);
    expect(stopped).toEqual(['conv-old-idle']);
    expect(result.reaped).toEqual(['conv-old-idle']);
  });

  it('leaves recently idle sessions alone', async () => {
    const { deps, stopped } = makeDeps({ 'conv-fresh-idle': idleEvents(RECENT) });
    await reapIdleSessions(makeSessionInfoService(), NOW, deps);
    expect(stopped).toEqual([]);
  });

  it('never touches a streaming session, however old its last event', async () => {
    const { deps, stopped } = makeDeps({ 'conv-streaming': streamingEvents(OLD) });
    await reapIdleSessions(makeSessionInfoService(), NOW, deps);
    expect(stopped).toEqual([]);
  });

  it('skips sessions holding pending background work', async () => {
    const events: EventShape[] = [
      ...idleEvents(OLD).slice(0, -1),
      { type: 'task:started', timestamp: OLD - 5_000, data: { taskId: 't1' } },
      { type: 'turn:end', timestamp: OLD, data: {} },
    ];
    const { deps, stopped } = makeDeps({ 'conv-bg-work': events });
    await reapIdleSessions(makeSessionInfoService(), NOW, deps);
    expect(stopped).toEqual([]);
  });

  it('skips team sessions', async () => {
    const { deps, stopped } = makeDeps({ 'conv-team': idleEvents(OLD) });
    await reapIdleSessions(makeSessionInfoService({ 'conv-team': 'alpha' }), NOW, deps);
    expect(stopped).toEqual([]);
  });

  it('skips sessions with a compaction in flight', async () => {
    const events: EventShape[] = [
      ...idleEvents(OLD),
      { type: 'context:compaction', timestamp: OLD + 1_000, data: { phase: 'started' } },
    ];
    const { deps, stopped } = makeDeps({ 'conv-compacting': events });
    await reapIdleSessions(makeSessionInfoService(), NOW, deps);
    expect(stopped).toEqual([]);
  });

  it('ignores non-conv session ids', async () => {
    const { deps, stopped } = makeDeps({ 'legacy-session': idleEvents(OLD) });
    const result = await reapIdleSessions(makeSessionInfoService(), NOW, deps);
    expect(stopped).toEqual([]);
    expect(result.examined).toBe(1);
  });
});
