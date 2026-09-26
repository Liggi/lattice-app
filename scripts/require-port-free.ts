/**
 * Refuse to start the dev server when its port is already taken.
 *
 * This replaces a predev line that read
 *
 *   { fuser -k 3001/tcp || lsof -ti:3001 | xargs kill -9; } 2>/dev/null || true
 *
 * and was wrong twice over. `lsof -ti:<port>` lists every process holding a
 * socket on that port, which is the listener AND every client connected to it.
 * On 2026-09-21 the same selector, run against a throwaway server's port,
 * killed four unrelated Claude workers that were connected to it to serve
 * permission hooks. Nothing about the port number made that safe; the selector
 * was the defect. Second, the port was hard-coded to 3001 while the server
 * takes its port from config, so on a deployment configured for another port
 * the line would kill a listener on 3001 that the dev run was not going to use
 * at all.
 *
 * So this kills nothing. It resolves the port the server is actually about to
 * bind, tries to bind it, and on failure names the listener and stops. Ending
 * another process is left to the person who knows whether it is wanted, with a
 * pid in hand rather than a port.
 */

import net from 'net';
import { ConfigService } from '../src/services/infrastructure/config-service.js';
import { findPortListeners, isPortServed } from '../src/utils/port-in-use.js';
import { CONFIG_FILE } from '../src/utils/constants.js';

async function bindable(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code ?? error.message);
    });
    probe.once('listening', () => {
      probe.close(() => resolve(null));
    });
    // exclusive so the probe reports a conflict rather than quietly sharing
    // the port with an existing listener.
    probe.listen({ host, port, exclusive: true });
  });
}

async function main(): Promise<number> {
  const configService = ConfigService.getInstance();
  await configService.initialize();
  const { host, port } = configService.getConfig().server;

  // A successful bind is not enough on macOS: 127.0.0.1 binds even while
  // another process holds *:<port>. See src/utils/port-in-use.ts.
  const failure = await isPortServed(host, port) ? 'EADDRINUSE' : await bindable(host, port);
  if (!failure) return 0;

  const lines = [`Port ${port} on ${host} is not available (${failure}).`];
  if (failure === 'EADDRINUSE') {
    const listeners = await findPortListeners(port);
    if (listeners.length > 0) {
      lines.push('Held by:');
      for (const listener of listeners) {
        lines.push(`  ${listener.command} (pid ${listener.pid})`);
      }
      lines.push(
        '',
        'If that is a server you no longer need, stop that pid:',
        ...listeners.map((listener) => `  kill ${listener.pid}`),
      );
    }
    lines.push(
      '',
      `Or run this instance on another port by setting server.port in ${CONFIG_FILE}.`,
      '',
      'Nothing is killed by port here on purpose: a port selector also matches',
      'every client connected to that port, which is how four unrelated workers',
      'were killed on 2026-09-21.',
    );
  }
  console.error(lines.join('\n'));
  return 1;
}

main().then(
  // ConfigService.initialize() starts a file watcher and a poll interval, so
  // the process would otherwise stay alive after the check has answered.
  (code) => process.exit(code),
  (error) => {
    console.error(`Could not check whether the server port is free: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
);
