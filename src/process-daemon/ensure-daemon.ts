/**
 * Ensure the process daemon is running and reachable.
 *
 * Published npm installs don't ship with a systemd unit, so the server
 * auto-spawns the daemon as a child process when the socket isn't reachable.
 * If a daemon is already running (systemd-managed dev setup), this short-circuits.
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { LatticeError } from '../types/index.js';
import { createLogger } from '../services/infrastructure/logger.js';
import { decideSocketPath } from './resolve-socket-path.js';
import { ensureLatticeLogDir } from '../services/infrastructure/structured-log-files.js';

const logger = createLogger('EnsureDaemon');

const CONNECT_PROBE_TIMEOUT_MS = 500;
const READY_POLL_INTERVAL_MS = 100;
const READY_POLL_TIMEOUT_MS = 10_000;

export interface EnsureDaemonResult {
  socketPath: string;
  spawned: boolean;
  child: ChildProcess | null;
}

/**
 * Attempt a short TCP-over-unix-socket probe. Resolves true if the socket
 * is currently accepting connections.
 */
async function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection(socketPath);
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => settle(false), CONNECT_PROBE_TIMEOUT_MS);
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

async function waitForSocketReady(socketPath: string): Promise<void> {
  const deadline = Date.now() + READY_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeSocket(socketPath)) return;
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  throw new LatticeError(
    'DAEMON_SPAWN_TIMEOUT',
    `Daemon child process did not become ready within ${READY_POLL_TIMEOUT_MS}ms at ${socketPath}`,
    503,
  );
}

/** The daemon beside this module: compiled `index.js` in a build, `index.ts` when running from source under tsx. */
function resolveDaemonEntry(): string {
  const fromSource = import.meta.url.endsWith('.ts');
  return fileURLToPath(new URL(fromSource ? './index.ts' : './index.js', import.meta.url));
}

function unlinkStaleSocket(socketPath: string): void {
  try {
    const stat = fs.statSync(socketPath);
    if (stat.isSocket()) {
      fs.unlinkSync(socketPath);
      logger.info('Removed stale daemon socket', { socketPath });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('Failed to check/remove stale socket', {
        socketPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Ensure a daemon is reachable on the socket. If one already is, return immediately.
 * Otherwise spawn the daemon binary as a child process and wait for readiness.
 *
 * Throws if the daemon cannot be started or does not become ready in time.
 */
/**
 * Socket selection lives in resolve-socket-path.ts so that ensureDaemon, the
 * daemon it spawns, and the standalone daemon all make the same decision.
 */
export function resolveSocketPath(): string {
  const decision = decideSocketPath();
  if (decision.unboundOverride) {
    logger.warn('Daemon socket override is not bound to this config dir; using its own socket', {
      override: decision.unboundOverride,
      using: decision.socketPath,
      reason: decision.reason,
    });
  }
  return decision.socketPath;
}

export async function ensureDaemon(): Promise<EnsureDaemonResult> {
  const socketPath = resolveSocketPath();

  if (await probeSocket(socketPath)) {
    logger.info('Daemon already running', { socketPath });
    return { socketPath, spawned: false, child: null };
  }

  unlinkStaleSocket(socketPath);

  const daemonEntry = resolveDaemonEntry();
  if (!fs.existsSync(daemonEntry)) {
    throw new LatticeError(
      'DAEMON_ENTRY_MISSING',
      `Daemon entry point not found at ${daemonEntry}. Run a build before starting the server.`,
      500,
    );
  }

  const logDir = ensureLatticeLogDir();
  const logPath = path.join(logDir, 'daemon.log');
  const logStream = fs.openSync(logPath, 'a');

  logger.info('Spawning daemon child process', { daemonEntry, socketPath, logPath });

  // execArgv carries tsx's loader when running from source, so the child can load index.ts.
  const child = spawn(process.execPath, [...process.execArgv, daemonEntry], {
    stdio: ['ignore', logStream, logStream],
    env: {
      ...process.env,
      LATTICE_DAEMON_SOCKET: socketPath,
    },
    detached: false,
  });

  child.once('error', (err) => {
    logger.error('Daemon child process error', err);
  });

  child.once('exit', (code, signal) => {
    logger.warn('Daemon child process exited', { code, signal });
  });

  try {
    await waitForSocketReady(socketPath);
  } catch (err) {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    throw err;
  }

  logger.info('Daemon child process ready', { socketPath, pid: child.pid });
  return { socketPath, spawned: true, child };
}
