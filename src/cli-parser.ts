import { createLogger } from './services/infrastructure/logger.js';

export interface CLIConfig {
  port?: number;
  host?: string;
  /** Working directory where lattice was invoked from */
  cwd?: string;
}

/**
 * Parse command line arguments
 */
export function parseArgs(argv: string[]): CLIConfig {
  const logger = createLogger('CLIParser');
  const args = argv.slice(2);
  // Capture the working directory where lattice was invoked
  const config: CLIConfig = {
    cwd: process.cwd()
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--port':
        if (i + 1 < args.length) {
          const portValue = parseInt(args[++i], 10);
          if (!isNaN(portValue) && portValue > 0 && portValue <= 65535) {
            config.port = portValue;
          } else {
            logger.error(`Invalid port value: ${args[i]}`);
            process.exit(1);
          }
        } else {
          logger.error('--port requires a value');
          process.exit(1);
        }
        break;

      case '--host':
        if (i + 1 < args.length) {
          config.host = args[++i];
        } else {
          logger.error('--host requires a value');
          process.exit(1);
        }
        break;

      default:
        logger.error(`Unknown argument: ${arg}`);
        logger.info('Usage: lattice [--port <number>] [--host <string>]');
        process.exit(1);
    }
  }

  return config;
}