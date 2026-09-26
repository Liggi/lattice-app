/**
 * The team watcher's 5s poll ran unconditionally from boot: a teams readdir,
 * an inbox readdir + statSync per team, and a zombie check that can walk
 * ~/.claude/projects — forever, even on a machine that has never created a
 * team. These tests pin the early-out and the idle backoff.
 *
 * The service resolves ~/.claude/teams once in its constructor via
 * os.homedir(), which honours $HOME on POSIX, so HOME is redirected at a temp
 * dir before the module is (re)imported.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const FAST_MS = 5000;
const IDLE_MS = 60_000;

let tmpHome: string;
let originalHome: string | undefined;

async function freshWatcher() {
  vi.resetModules();
  const mod = await import('../../src/services/teams/team-watcher-service.js');
  return new mod.TeamWatcherService();
}

function currentInterval(watcher: unknown): number {
  return (watcher as { currentPollIntervalMs: number }).currentPollIntervalMs;
}

function polledFiles(watcher: unknown): string[] {
  return [...(watcher as { lastPollSnapshot: Map<string, number> }).lastPollSnapshot.keys()];
}

function makeTeam(name: string): void {
  const teamDir = path.join(tmpHome, '.claude', 'teams', name);
  fs.mkdirSync(path.join(teamDir, 'inboxes'), { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, 'config.json'),
    JSON.stringify({ name, leadAgentId: 'lead', leadSessionId: 'lead-session', members: [], createdAt: Date.now() }),
  );
}

describe('TeamWatcherService idle polling', () => {
  beforeAll(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-team-watcher-'));
    // The shared logger writes under ~/.lattice/logs; pre-create it so its
    // lazy mkdir can't race this suite's cleanup.
    fs.mkdirSync(path.join(tmpHome, '.lattice', 'logs'), { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterAll(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(tmpHome, '.claude'), { recursive: true, force: true });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves its teams dir under the redirected home', async () => {
    const watcher = await freshWatcher();
    expect((watcher as unknown as { teamsDir: string }).teamsDir)
      .toBe(path.join(tmpHome, '.claude', 'teams'));
  });

  it('skips per-team work entirely when no teams exist', async () => {
    const watcher = await freshWatcher();
    watcher.start();

    vi.advanceTimersByTime(FAST_MS * 2);
    // Per-team work is what populates the mtime snapshot; nothing was walked.
    expect(polledFiles(watcher)).toEqual([]);

    watcher.stop();
  });

  it('does walk per-team files once a team exists', async () => {
    makeTeam('squad');
    const watcher = await freshWatcher();
    watcher.start();

    vi.advanceTimersByTime(FAST_MS);

    expect(polledFiles(watcher)).toContain(
      path.join(tmpHome, '.claude', 'teams', 'squad', 'config.json'),
    );

    watcher.stop();
  });

  it('backs off to the slow interval after repeated empty ticks', async () => {
    const watcher = await freshWatcher();
    watcher.start();
    expect(currentInterval(watcher)).toBe(FAST_MS);

    vi.advanceTimersByTime(FAST_MS * 3);
    expect(currentInterval(watcher)).toBe(IDLE_MS);

    watcher.stop();
  });

  it('snaps back to the fast interval when a team appears', async () => {
    const watcher = await freshWatcher();
    watcher.start();

    vi.advanceTimersByTime(FAST_MS * 3);
    expect(currentInterval(watcher)).toBe(IDLE_MS);

    makeTeam('squad');
    vi.advanceTimersByTime(IDLE_MS);

    expect(currentInterval(watcher)).toBe(FAST_MS);

    watcher.stop();
  });

  it('snaps back to the fast interval when an SSE consumer subscribes', async () => {
    const watcher = await freshWatcher();
    watcher.start();

    vi.advanceTimersByTime(FAST_MS * 3);
    expect(currentInterval(watcher)).toBe(IDLE_MS);

    watcher.on('team-inbox-update', () => {});
    expect(currentInterval(watcher)).toBe(FAST_MS);

    watcher.stop();
  });

  it('keeps a fast poll while a team directory exists', async () => {
    makeTeam('squad');
    const watcher = await freshWatcher();
    watcher.start();

    vi.advanceTimersByTime(FAST_MS * 5);
    expect(currentInterval(watcher)).toBe(FAST_MS);

    watcher.stop();
  });
});
