import pino, { Logger as PinoLogger } from 'pino';
import { PassThrough } from 'stream';
import { LogFormatter } from './log-formatter.js';
import {
  ensureLatticeLogDir,
  SERVER_JSONL_LOG_PATH,
  DAEMON_JSONL_LOG_PATH,
} from './structured-log-files.js';

export interface LogContext {
  component?: string;
  sessionId?: string;
  streamingId?: string;
  requestId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * Wrapper class for Pino logger that provides an intuitive API
 * Translates logger.method('message', context) to Pino's logger.method(context, 'message')
 */
export type Logger = CUILogger;

export class CUILogger {
  constructor(private pinoLogger: PinoLogger) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug(message: string, context?: any): void {
    if (context !== undefined) {
      this.pinoLogger.debug(context, message);
    } else {
      this.pinoLogger.debug(message);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  info(message: string, context?: any): void {
    if (context !== undefined) {
      this.pinoLogger.info(context, message);
    } else {
      this.pinoLogger.info(message);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn(message: string, context?: any): void {
    if (context !== undefined) {
      this.pinoLogger.warn(context, message);
    } else {
      this.pinoLogger.warn(message);
    }
  }

  error(message: string, error?: Error | unknown, context?: Record<string, unknown>): void {
    if (error instanceof Error) {
      const logData = { err: error, ...context };
      this.pinoLogger.error(logData, message);
    } else if (error !== undefined && context !== undefined) {
      // error is actually context, context is extra data
      const logData = { ...(error as Record<string, unknown>), ...context };
      this.pinoLogger.error(logData, message);
    } else if (error !== undefined) {
      // error is context
      this.pinoLogger.error(error as Record<string, unknown>, message);
    } else {
      this.pinoLogger.error(message);
    }
  }

  fatal(message: string, error?: Error | unknown, context?: Record<string, unknown>): void {
    if (error instanceof Error) {
      const logData = { err: error, ...context };
      this.pinoLogger.fatal(logData, message);
    } else if (error !== undefined && context !== undefined) {
      // error is actually context, context is extra data
      const logData = { ...(error as Record<string, unknown>), ...context };
      this.pinoLogger.fatal(logData, message);
    } else if (error !== undefined) {
      // error is context
      this.pinoLogger.fatal(error as Record<string, unknown>, message);
    } else {
      this.pinoLogger.fatal(message);
    }
  }

  // Support for creating child loggers
  child(context: LogContext): CUILogger {
    return new CUILogger(this.pinoLogger.child(context));
  }
}

const LOGGER_SERVICE_SINGLETON_KEY = Symbol.for('lattice.logger-service');
type GlobalLoggerStore = typeof globalThis & {
  [LOGGER_SERVICE_SINGLETON_KEY]?: LoggerService;
};

/**
 * Centralized logger service using Pino
 * Provides consistent logging across all Lattice components
 * Log level is controlled by LOG_LEVEL environment variable
 */
class LoggerService {
  private static instance: LoggerService;
  private baseLogger: PinoLogger;
  private logInterceptStream: PassThrough;
  private childLoggers: Map<string, PinoLogger> = new Map();

  private constructor() {
    const logLevel = process.env.LOG_LEVEL || 'info';
    const roleEnv = process.env.LATTICE_PROCESS_ROLE;
    const processRole: 'cli' | 'daemon' | 'server' =
      roleEnv === 'cli' ? 'cli' : roleEnv === 'daemon' ? 'daemon' : 'server';
    const shouldWriteToStdout = process.env.NODE_ENV !== 'test' || logLevel === 'debug';
    const shouldAttachInMemoryBuffer = processRole === 'server';
    // CLI is short-lived and may run under a read-only sandbox where the
    // ~/.lattice/logs/ dir isn't writable — skip the on-disk JSONL stream
    // entirely. (sonic-boom's async open + autoEnd flush is the source of
    // the "sonic boom is not ready yet" crash on exit when the dir is r-o.)
    const shouldWriteStructuredFile = processRole !== 'cli';
    const structuredLogPath = processRole === 'daemon' ? DAEMON_JSONL_LOG_PATH : SERVER_JSONL_LOG_PATH;

    if (shouldWriteStructuredFile) {
      ensureLatticeLogDir();
    }

    // Create a pass-through stream to intercept logs
    this.logInterceptStream = new PassThrough();

    // Forward logs to the log buffer (lazy loaded to avoid circular dependency)
    this.logInterceptStream.on('data', (chunk: Buffer | string) => {
      if (!shouldAttachInMemoryBuffer) {
        return;
      }
      const logLine = chunk.toString().trim();
      if (logLine) {
        // Lazy load to avoid circular dependency
        import('@/services/infrastructure/log-stream-buffer').then(({ logStreamBuffer }) => {
          logStreamBuffer.addLog(logLine);
        }).catch(() => {
          // Silently ignore if log buffer is not available
        });
      }
    });

    // Create multi-stream configuration with formatter. Built via spreads
    // so TypeScript infers the right `pino.StreamEntry` element type rather
    // than narrowing the array element to `{ stream: NodeJS.WritableStream }`
    // (which doesn't accept pino's SonicBoom return type without a cast).
    const stdoutFormatter = shouldWriteToStdout ? new LogFormatter() : null;
    if (stdoutFormatter) {
      stdoutFormatter.pipe(process.stdout);
    }
    const streams = [
      ...(stdoutFormatter
        ? [{ level: logLevel as pino.Level, stream: stdoutFormatter }]
        : []),
      { level: logLevel as pino.Level, stream: this.logInterceptStream },
      ...(shouldWriteStructuredFile
        ? [{
            level: logLevel as pino.Level,
            stream: pino.destination({ dest: structuredLogPath, mkdir: true, sync: false }),
          }]
        : []),
    ];

    // CLI: suppress logs entirely. Subcommands write to stdout themselves;
    // any debug chatter from DatabaseProvider et al. would corrupt machine-
    // readable output (--json) and isn't useful for short-lived commands.
    const enabled = processRole === 'cli'
      ? false
      : (process.env.NODE_ENV !== 'test' || logLevel === 'debug');

    this.baseLogger = pino({
      level: logLevel,
      formatters: {
        level: (label) => {
          return { level: label };
        }
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      // Enable in test environment if debug level, otherwise suppress
      enabled,
    }, pino.multistream(streams));
  }

  /**
   * Get the singleton logger instance
   */
  static getInstance(): LoggerService {
    const globalStore = globalThis as GlobalLoggerStore;
    if (globalStore[LOGGER_SERVICE_SINGLETON_KEY]) {
      LoggerService.instance = globalStore[LOGGER_SERVICE_SINGLETON_KEY]!;
      return LoggerService.instance;
    }
    if (!LoggerService.instance) {
      LoggerService.instance = new LoggerService();
      globalStore[LOGGER_SERVICE_SINGLETON_KEY] = LoggerService.instance;
    }
    return LoggerService.instance;
  }

  /**
   * Create a child logger with context
   */
  child(context: LogContext): CUILogger {
    const contextKey = JSON.stringify(context);
    if (!this.childLoggers.has(contextKey)) {
      this.childLoggers.set(contextKey, this.baseLogger.child(context));
    }
    return new CUILogger(this.childLoggers.get(contextKey)!);
  }

  /**
   * Get the base logger
   */
  getLogger(): CUILogger {
    return new CUILogger(this.baseLogger);
  }

  /**
   * Log debug message
   */
  debug(message: string, context?: LogContext): void {
    if (context) {
      this.baseLogger.child(context).debug(message);
    } else {
      this.baseLogger.debug(message);
    }
  }

  /**
   * Log info message
   */
  info(message: string, context?: LogContext): void {
    if (context) {
      this.baseLogger.child(context).info(message);
    } else {
      this.baseLogger.info(message);
    }
  }

  /**
   * Log warning message
   */
  warn(message: string, context?: LogContext): void {
    if (context) {
      this.baseLogger.child(context).warn(message);
    } else {
      this.baseLogger.warn(message);
    }
  }

  /**
   * Log error message
   */
  error(message: string, error?: Error | unknown, context?: LogContext): void {
    const logData = error ? { err: error } : {};
    if (context) {
      this.baseLogger.child({ ...context, ...logData }).error(message);
    } else {
      this.baseLogger.error(logData, message);
    }
  }

  /**
   * Log fatal message
   */
  fatal(message: string, error?: Error | unknown, context?: LogContext): void {
    const logData = error ? { err: error } : {};
    if (context) {
      this.baseLogger.child({ ...context, ...logData }).fatal(message);
    } else {
      this.baseLogger.fatal(logData, message);
    }
  }
}

// Export singleton instance
export const logger = LoggerService.getInstance();

// Export factory function for creating component loggers
export function createLogger(component: string, baseContext?: LogContext): CUILogger {
  const context = { component, ...baseContext };
  return logger.child(context);
}
