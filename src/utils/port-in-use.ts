/**
 * Is something already serving the port this server is about to bind?
 *
 * A bind attempt cannot answer that on macOS. Node sets SO_REUSEADDR on its
 * listening sockets, and with it macOS lets `127.0.0.1:<port>` bind while
 * another process holds `*:<port>`. The bind succeeds, and from then on
 * connections to localhost reach this server instead of the one that was
 * there first. Linux refuses the second bind; macOS does not, even with
 * `exclusive: true`.
 *
 * So this connects instead. A connection that is accepted means a client of
 * this address would reach whoever is already listening, which is exactly the
 * case to refuse.
 *
 * For a loopback or wildcard host it tries both loopback families. The older
 * npm release listens on `localhost`, which on macOS is `[::1]` only, so a
 * 127.0.0.1 probe misses it, this server binds 127.0.0.1 beside it, and a
 * browser opening http://localhost:<port> reaches the old one instead.
 */

import net from 'net';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { CONFIG_FILE } from './constants.js';

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 1000;

export interface PortListener {
  command: string;
  pid: string;
}

const LOOPBACK_OR_WILDCARD = new Set(['', 'localhost', '127.0.0.1', '::1', '0.0.0.0', '::']);

/** The addresses a client of `host` could reach this port on. */
function probeHosts(host: string): string[] {
  return LOOPBACK_OR_WILDCARD.has(host) ? ['127.0.0.1', '::1'] : [host];
}

/** True when a connection to host:port is accepted. */
function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    // Read and discard whatever the server sends: closing with unread data
    // resets the connection, and the server should see an ordinary close.
    socket.resume();
    socket.on('error', () => resolve(false));
    socket.setTimeout(PROBE_TIMEOUT_MS, () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('connect', () => {
      socket.setTimeout(0);
      socket.end();
      resolve(true);
    });
  });
}

/** True when something already answers where a client of host:port would connect. */
export async function isPortServed(host: string, port: number): Promise<boolean> {
  const results = await Promise.all(probeHosts(host).map((address) => accepts(address, port)));
  return results.some(Boolean);
}

/**
 * The listeners on a port, if lsof can name them.
 *
 * -sTCP:LISTEN matters: without it lsof also returns every client connected to
 * the port. Failure to identify the holder is not fatal; the port is occupied
 * either way.
 */
export async function findPortListeners(port: number): Promise<PortListener[]> {
  try {
    const { stdout } = await execFileAsync('lsof', [
      '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'cp',
    ]);
    const listeners: PortListener[] = [];
    let pid = '';
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) pid = line.slice(1);
      else if (line.startsWith('c')) listeners.push({ command: line.slice(1), pid });
    }
    return listeners;
  } catch {
    return [];
  }
}

/** A multi-line explanation for a port that is taken, naming its holder when known. */
export async function describePortInUse(host: string, port: number): Promise<string> {
  const lines = [`Port ${port} is already in use, so Lattice did not start (it would have shadowed that server on ${host}).`];
  const listeners = await findPortListeners(port);
  if (listeners.length > 0) {
    lines.push('Held by:', ...listeners.map((listener) => `  ${listener.command} (pid ${listener.pid})`));
  }
  lines.push(`Stop that server, or run Lattice on another port with --port <N> or server.port in ${CONFIG_FILE}.`);
  return lines.join('\n');
}
