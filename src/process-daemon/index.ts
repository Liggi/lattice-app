#!/usr/bin/env node
/**
 * Process Daemon Entry Point
 *
 * Run this separately from the main lattice-server. It manages Claude CLI
 * processes and outlives nodemon / server restarts. See process-daemon.ts for
 * the durability caveat — PTYs survive but in-flight stream events do not.
 *
 * Usage:
 *   npx tsx src/process-daemon/index.ts
 *   # or after build:
 *   node dist/process-daemon/index.js
 */

import { decideSocketPath } from './resolve-socket-path.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { rotateOversizedLogs } from '../services/infrastructure/structured-log-files.js';
import { getEventJournal } from '../services/infrastructure/event-journal.js';
import { parseJson } from '../utils/json.js';

process.env.LATTICE_PROCESS_ROLE = 'daemon';
rotateOversizedLogs();

type ClaudeSettings = {
  env?: Record<string, unknown>;
};

function loadClaudeEnvOverrides(): Record<string, string> {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

  try {
    if (!fs.existsSync(settingsPath)) {
      return {};
    }

    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const parsed = parseJson(raw) as ClaudeSettings;

    if (!parsed.env || typeof parsed.env !== 'object') {
      return {};
    }

    const overrides: Record<string, string> = {};

    for (const [key, value] of Object.entries(parsed.env)) {
      if (value === undefined || value === null) {
        continue;
      }
      overrides[key] = String(value);
    }

    return overrides;
  } catch (_error) {
    return {};
  }
}

const envOverrides = loadClaudeEnvOverrides();

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
