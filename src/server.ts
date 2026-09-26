#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { LatticeServer } from './lattice-server.js';
import { createLogger } from './services/infrastructure/logger.js';
import type { Logger } from './services/infrastructure/logger.js';
import { parseArgs } from './cli-parser.js';
import { rotateOversizedLogs } from './services/infrastructure/structured-log-files.js';
import { getEventJournal } from './services/infrastructure/event-journal.js';

let globalServer: LatticeServer | null = null;
let logger: Logger | null = null;

export async function main(): Promise<void> {
  rotateOversizedLogs();
  const serverLogger = createLogger('Server');
  logger = serverLogger;
  const cliConfig = parseArgs(process.argv);
  globalServer = new LatticeServer(cliConfig);
  getEventJournal().record({
    event: 'system.startup',
    component: 'Server',
    fields: {
      nodeVersion: process.version,
      processRole: 'server',
      logLevel: process.env.LOG_LEVEL || 'info',
      port: cliConfig.port,
      host: cliConfig.host,
      pid: process.pid,
    },
  });
  
  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    serverLogger.info(`Received ${signal}, shutting down...`);
    if (globalServer) {
      await globalServer.stop();
    }
    process.exit(0);
  };
  
  // Set up signal handlers before starting server
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  
  try {
    await globalServer.start();
  } catch (error) {
    serverLogger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server only when this file is the entry point (e.g. node dist/server.js).
// When imported by src/cli.ts (`lattice serve`), main() is called explicitly there.
const isMainModule = process.argv[1] !== undefined &&
  process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error) => {
    if (logger) {
      logger.error('Unhandled error during server bootstrap', error);
    } else {
      console.error('Unhandled error:', error);
    }
    process.exit(1);
  });
}
