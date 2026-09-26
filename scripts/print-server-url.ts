/**
 * Print the URL this checkout's server answers on, from the same config the
 * server reads, so restart-server.sh health-checks the port actually in use
 * instead of assuming 3001.
 */

import { ConfigService } from '../src/services/infrastructure/config-service.js';

async function main(): Promise<void> {
  const configService = ConfigService.getInstance();
  await configService.initialize();
  const { host, port } = configService.getConfig().server;
  // A wildcard bind answers on loopback; an IPv6 literal needs brackets in a URL.
  const reachable = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  console.log(`http://${reachable.includes(':') ? `[${reachable}]` : reachable}:${port}`);
}

main().then(
  // ConfigService.initialize() starts a file watcher, so exit explicitly.
  () => process.exit(0),
  (error) => {
    console.error(`Could not read the server address: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
);
