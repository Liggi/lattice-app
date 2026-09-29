/**
 * Lifecycle for the shared `opencode serve` process.
 *
 * opencode exposes one HTTP server that owns every session, so Lattice starts
 * at most one and reuses it. The server is started on port 0 and reports the
 * port it actually bound on stdout, which avoids colliding with an opencode
 * the user is running themselves.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { agentEnv } from '../services/infrastructure/agent-env.js';
import { createLogger } from '../services/infrastructure/logger.js';

const logger = createLogger('OpencodeServer');

/** opencode prints this once the listener is bound. */
const LISTENING_RE = /listening on (http:\/\/\S+)/i;

const STARTUP_TIMEOUT_MS = 30_000;

/**
 * opencode treats `--port 0` as "use the default" rather than "pick a free
 * port", so a server the user started themselves would collide with ours.
 * Reuse theirs when it answers, rather than failing to bind.
 */
const DEFAULT_BASE_URL = process.env.LATTICE_OPENCODE_URL ?? 'http://127.0.0.1:4096';

async function probeExisting(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/global/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface OpencodeServerHandle {
  baseUrl: string;
  stop: () => void;
}

let starting: Promise<OpencodeServerHandle> | null = null;
let running: OpencodeServerHandle | null = null;
let child: ChildProcess | null = null;

/**
 * Start the shared server, or return the already-running one.
 *
 * Concurrent callers share a single in-flight startup rather than racing to
 * spawn competing servers.
 */
export function getOpencodeServer(binary = 'opencode'): Promise<OpencodeServerHandle> {
  if (running) return Promise.resolve(running);
  if (starting) return starting;

  starting = (async (): Promise<OpencodeServerHandle> => {
    if (await probeExisting(DEFAULT_BASE_URL)) {
      // Someone else owns this process, so stop() must not kill it.
      const handle: OpencodeServerHandle = { baseUrl: DEFAULT_BASE_URL, stop: () => {} };
      running = handle;
      logger.info('Reusing an already-running opencode server', { baseUrl: handle.baseUrl });
      return handle;
    }
    return spawnServer(binary);
  })().catch((err: unknown) => {
    starting = null;
    throw err;
  });

  return starting;
}

function spawnServer(binary: string): Promise<OpencodeServerHandle> {
  return new Promise<OpencodeServerHandle>((resolve, reject) => {
    const proc = spawn(binary, ['serve', '--hostname', '127.0.0.1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: agentEnv(),
    });
    child = proc;

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGTERM');
      reject(new Error(`opencode serve did not report a listening address within ${STARTUP_TIMEOUT_MS}ms`));
    }, STARTUP_TIMEOUT_MS);

    const inspect = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      const match = LISTENING_RE.exec(text);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      const handle: OpencodeServerHandle = {
        baseUrl: match[1].replace(/\/+$/, ''),
        stop: () => {
          proc.kill('SIGTERM');
        },
      };
      running = handle;
      logger.info('opencode server ready', { baseUrl: handle.baseUrl, pid: proc.pid });
      resolve(handle);
    };

    proc.stdout?.on('data', inspect);
    // opencode writes the listening banner to stderr in some versions.
    proc.stderr?.on('data', inspect);

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to start "${binary} serve": ${err.message}`));
    });

    proc.on('exit', (code, signal) => {
      logger.warn('opencode server exited', { code, signal });
      running = null;
      starting = null;
      child = null;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`opencode serve exited before binding (code ${code}, signal ${signal})`));
    });
  });
}

/** Stop the shared server. Used by tests and shutdown paths. */
export function stopOpencodeServer(): void {
  child?.kill('SIGTERM');
  child = null;
  running = null;
  starting = null;
}
