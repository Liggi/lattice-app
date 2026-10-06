/**
 * Ensure the process daemon is running and reachable.
 *
 * Published npm installs don't ship with a systemd unit, so the server
 * auto-spawns the daemon when the socket isn't reachable. It is started in its
 * own session and outlives the server: a server restart, or a Ctrl-C in the
 * terminal the server runs in, leaves it and its agents running for the next
 * server. A daemon already running is kept unless it was started with other
 * code or Claude settings (daemon-identity.ts), in which case it is restarted.
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { LatticeError } from '../types/index.js';
import { parseJson } from '../utils/json.js';
import { createLogger } from '../services/infrastructure/logger.js';
import { decideSocketPath } from './resolve-socket-path.js';
import { ensureLatticeLogDir } from '../services/infrastructure/structured-log-files.js';
import { daemonIdentity, loadClaudeEnvOverrides } from './daemon-identity.js';
import type { DaemonIdentityResult, IPCResponse } from './types.js';

const logger = createLogger('EnsureDaemon');

const CONNECT_PROBE_TIMEOUT_MS = 500;
const READY_POLL_INTERVAL_MS = 100;
const READY_POLL_TIMEOUT_MS = 10_000;

export interface EnsureDaemonResult {
  socketPath: string;
  spawned: boolean;
  child: ChildProcess | null;
  /** The running daemon this call stopped because it was started with other code or settings. */
  replaced?: { pid: number; identity: string | null; wanted: string };
}

const IDENTITY_REQUEST_TIMEOUT_MS = 2_000;
/** A daemon started here stops after this long with no server connected. */
const EXIT_WITHOUT_SERVER_MS = 30 * 60_000;
const STOP_WAIT_MS = 15_000;

/** Ask the daemon on the socket which it is. Null when it predates the `identity` request. */
async function requestIdentity(socketPath: string): Promise<DaemonIdentityResult | null> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    const timer = setTimeout(() => finish(new Error('Daemon did not answer the identity request')), IDENTITY_REQUEST_TIMEOUT_MS);
    const finish = (err: Error | null, value?: DaemonIdentityResult | null) => {
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value ?? null);
    };
    socket.once('connect', () => socket.write(JSON.stringify({ id: 1, method: 'identity', params: {} }) + '\n'));
    socket.once('error', (err) => finish(err));
    socket.on('data', (data) => {
      buffer += data.toString();
      for (const line of buffer.split('\n').slice(0, -1)) {
        const message = parseJson(line) as IPCResponse;
        if (message.id !== 1) continue;
        if (message.error) {
          if (message.error.message.startsWith('Unknown method')) finish(null, null);
          else finish(new Error(message.error.message));
        } else {
          finish(null, message.result as DaemonIdentityResult);
        }
        return;
      }
    });
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stop a daemon and wait for it to exit; its own shutdown stops its agents first. */
async function stopDaemon(pid: number): Promise<void> {
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + STOP_WAIT_MS;
  while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  if (isAlive(pid)) {
    logger.warn('Daemon did not exit after SIGTERM; killing it', { pid });
    process.kill(pid, 'SIGKILL');
  }
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

  const daemonEntry = resolveDaemonEntry();
  let replaced: EnsureDaemonResult['replaced'];

  if (await probeSocket(socketPath)) {
    const running = await requestIdentity(socketPath);
    if (!running) {
      // Started by a server from before the identity request; it goes when it next stops.
      logger.warn('Daemon already running, and too old to say what it was started with; keeping it', { socketPath });
      return { socketPath, spawned: false, child: null };
    }
    const wanted = daemonIdentity(daemonEntry, loadClaudeEnvOverrides());
    if (running.identity === wanted) {
      logger.info('Daemon already running', { socketPath, pid: running.pid, identity: wanted });
      return { socketPath, spawned: false, child: null };
    }
    logger.warn('Daemon was started with other code or Claude settings; restarting it', {
      socketPath,
      pid: running.pid,
      running: running.identity,
      wanted,
    });
    await stopDaemon(running.pid);
    replaced = { pid: running.pid, identity: running.identity, wanted };
  }

  unlinkStaleSocket(socketPath);

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
  // Its own session: a signal to the server's process group (Ctrl-C) does not reach it.
  const child = spawn(process.execPath, [...process.execArgv, daemonEntry], {
    stdio: ['ignore', logStream, logStream],
    env: {
      ...process.env,
      LATTICE_DAEMON_SOCKET: socketPath,
      LATTICE_DAEMON_EXIT_WITHOUT_SERVER_MS: String(EXIT_WITHOUT_SERVER_MS),
    },
    detached: true,
  });
  child.unref();
  fs.closeSync(logStream);

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
  return { socketPath, spawned: true, child, ...(replaced ? { replaced } : {}) };
}
