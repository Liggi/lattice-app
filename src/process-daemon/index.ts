#!/usr/bin/env node
/**
 * Process Daemon Entry Point
 *
 * Run this separately from the main lattice-server. It manages Claude CLI
 * processes and outlives server restarts; a process's events are kept while no
 * server is attached and replayed to the next one (held-streams.ts).
 *
 * Usage:
 *   npx tsx src/process-daemon/index.ts
 *   # or after build:
 *   node dist/process-daemon/index.js
 */

import { decideSocketPath } from './resolve-socket-path.js';
import { rotateOversizedLogs } from '../services/infrastructure/structured-log-files.js';
import { getEventJournal } from '../services/infrastructure/event-journal.js';
import { fileURLToPath } from 'url';
import { daemonIdentity, loadClaudeEnvOverrides } from './daemon-identity.js';

process.env.LATTICE_PROCESS_ROLE = 'daemon';
rotateOversizedLogs();

const envOverrides = loadClaudeEnvOverrides();
// Read before anything else can change on disk, so it names the code this process loaded.
const identity = daemonIdentity(fileURLToPath(import.meta.url), envOverrides);

const { ProcessDaemon } = await import('./process-daemon.js');

const socketDecision = decideSocketPath();
if (socketDecision.unboundOverride) {
  console.warn(
    `[daemon] socket override ${socketDecision.unboundOverride} is not bound to this config dir `
    + `(${socketDecision.reason}); using ${socketDecision.socketPath}`
  );
}
const socketPath = socketDecision.socketPath;
const daemon = new ProcessDaemon({
  socketPath,
  envOverrides,
  identity,
});

getEventJournal().record({
  event: 'system.startup',
  component: 'ProcessDaemon',
  fields: {
    nodeVersion: process.version,
    processRole: 'daemon',
    logLevel: process.env.LOG_LEVEL || 'info',
    socketPath,
    pid: process.pid,
    identity,
  },
});

// Graceful shutdown handling
async function shutdown(_signal: string): Promise<void> {
  try {
    await daemon.stop();
    process.exit(0);
  } catch (error) {
    console.error('[DAEMON] Error during shutdown:', error);
    process.exit(1);
  }
}

// A daemon a server started outlives it, for the next server. One that no
// server connects to for this long is left from a Lattice nobody restarted.
const exitWithoutServerMs = Number(process.env.LATTICE_DAEMON_EXIT_WITHOUT_SERVER_MS) || 0;
// Not for the agents it starts, whose environment is copied from this one.
delete process.env.LATTICE_DAEMON_EXIT_WITHOUT_SERVER_MS;
if (exitWithoutServerMs > 0) {
  let timer: NodeJS.Timeout | null = null;
  const onClients = (count: number) => {
    if (timer) clearTimeout(timer);
    timer = count > 0 ? null : setTimeout(() => {
      console.error(`[DAEMON] No server connected for ${exitWithoutServerMs}ms; stopping`);
      void shutdown('no server');
    }, exitWithoutServerMs);
  };
  daemon.on('clients', onClients);
  onClients(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[DAEMON] Uncaught exception:', error);
  void shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  console.error('[DAEMON] Unhandled rejection:', reason);
  void shutdown('unhandledRejection');
});

// Start the daemon
daemon
  .start()
  .then(() => {
  })
  .catch((error) => {
    console.error('[DAEMON] Failed to start:', error);
    process.exit(1);
  });
