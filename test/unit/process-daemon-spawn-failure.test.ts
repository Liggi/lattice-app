/**
 * A worktree was deleted while a worker still had it as its cwd. Spawning
 * claude there made Node report `spawn .../claude ENOENT`; the daemon threw
 * "no PID assigned" before listening for the child's 'error' event, so the
 * event reached the uncaught-exception handler and the daemon stopped every
 * agent (2026-09-27). A failed spawn must fail only that session.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProcessDaemon } from '../../src/process-daemon/process-daemon.js';

interface DaemonInternals {
  processes: Map<string, unknown>;
  conversationConfigs: Map<string, unknown>;
  handleSpawn: (params: unknown) => Promise<unknown>;
  handleSpawnOptimistic: (params: unknown) => Promise<unknown>;
}

const missingDir = '/tmp/lattice-test-deleted-worktree-does-not-exist';
const spawnParams = (workingDirectory: string) => ({
  config: { workingDirectory, initialPrompt: 'hi', resumedSessionId: 'c25fb9e0-f970-40ab-b3a4-3931b060d06d' },
});

describe('ProcessDaemon spawn failure fails only that session', () => {
  let uncaught: unknown[];
  const onUncaught = (err: unknown) => { uncaught.push(err); };

  beforeEach(() => {
    uncaught = [];
    process.on('uncaughtException', onUncaught);
  });

  afterEach(() => {
    process.off('uncaughtException', onUncaught);
  });

  const daemonWith = (claudeExecutablePath: string) =>
    new ProcessDaemon({ socketPath: `/tmp/test-daemon-${Math.random()}.sock`, claudeExecutablePath }) as unknown as DaemonInternals;

  // Lets the child's nextTick 'error' event fire before asserting.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  it.each(['handleSpawnOptimistic', 'handleSpawn'] as const)(
    '%s rejects with a clear error when the working directory is missing',
    async (method) => {
      const daemon = daemonWith('/usr/bin/true');
      await expect(daemon[method](spawnParams(missingDir))).rejects.toMatchObject({
        code: 'WORKING_DIRECTORY_NOT_FOUND',
        message: expect.stringContaining(missingDir),
      });
      await settle();
      expect(uncaught).toEqual([]);
      expect(daemon.processes.size).toBe(0);
      expect(daemon.conversationConfigs.size).toBe(0);
    },
  );

  it.each(['handleSpawnOptimistic', 'handleSpawn'] as const)(
    '%s rejects with the spawn error when the binary is missing',
    async (method) => {
      const daemon = daemonWith('/tmp/lattice-test-no-such-claude-binary');
      await expect(daemon[method](spawnParams('/tmp'))).rejects.toMatchObject({
        code: 'PROCESS_SPAWN_FAILED',
        message: expect.stringContaining('ENOENT'),
      });
      await settle();
      expect(uncaught).toEqual([]);
      expect(daemon.processes.size).toBe(0);
    },
  );
});
