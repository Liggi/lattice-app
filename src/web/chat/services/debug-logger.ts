/**
 * Debug Logger - Captures browser logs and sends them to the server
 *
 * This enables debugging UI issues by having logs accessible from the filesystem
 * at ~/lattice-debug.log, combining both browser and server logs in one place.
 *
 * Usage for component-specific verbose logging:
 *   import { debugFlags, debugLog } from './debug-logger';
 *
 *   // In your component:
 *   if (debugFlags.tooltips) {
 *     debugLog('tooltips', 'Mouse enter', { x, y, target });
 *   }
 *
 *   // Enable from browser console:
 *   __latticeDebug.enable('tooltips')  // or 'all'
 *   __latticeDebug.disable('tooltips')
 *   __latticeDebug.list()  // show all flags
 */

interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
  data?: unknown;
}

/**
 * Debug flags for verbose logging of specific UI areas.
 * Enable from browser console with: __latticeDebug.enable('tooltips')
 */
export const debugFlags: Record<string, boolean> = {
  tooltips: false,     // Tooltip mouse events and positioning
  focus: false,        // Focus/blur events
  sse: false,          // SSE stream events (verbose!)
  insights: false,     // Insights updates and caching
  composer: false,     // Composer input and suggestions
  walkthrough: false,  // Walkthrough generation and rendering
  scroll: false,       // Scroll events
  navigation: false,   // Session switching and data loading
  messages: false,     // Message pipeline debug overlay
};

/**
 * Log a debug message if the flag is enabled.
 * Automatically prefixes with component name.
 */
export function debugLog(flag: keyof typeof debugFlags, message: string, data?: unknown): void {
  if (!debugFlags[flag]) return;
  const prefix = `[Debug:${flag}]`;
  if (data !== undefined) {
    console.warn(prefix, message, data);
  } else {
    console.warn(prefix, message);
  }
}

class DebugLogger {
  private buffer: LogEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly FLUSH_INTERVAL = 1000; // Flush every second
  private readonly MAX_BUFFER_SIZE = 50;
  private enabled = true;

  constructor() {
    // Intercept console.warn since that's what we use for debug logging
    this.interceptConsole();

    // Flush on page unload
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => void this.flush());
    }
  }

  private interceptConsole() {
    if (typeof window === 'undefined') return;

    const originalWarn = console.warn.bind(console);

    console.warn = (...args: unknown[]) => {
      // Call original first
      originalWarn(...args);

      // Capture if it looks like our debug logging (starts with [)
      if (this.enabled && typeof args[0] === 'string' && args[0].startsWith('[')) {
        this.capture('warn', args);
      }
    };
  }

  private capture(level: string, args: unknown[]) {
    const message = args.map(arg =>
      typeof arg === 'string' ? arg : JSON.stringify(arg)
    ).join(' ');

    this.buffer.push({
      level,
      message,
      timestamp: new Date().toISOString(),
    });

    // Auto-flush if buffer gets too big
    if (this.buffer.length >= this.MAX_BUFFER_SIZE) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  private scheduleFlush() {
    if (this.flushTimer) return;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.FLUSH_INTERVAL);
  }

  private async flush() {
    if (this.buffer.length === 0) return;

    const logs = [...this.buffer];
    this.buffer = [];

    try {
      await fetch('/api/logs/debug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logs, source: 'browser' }),
      });
    } catch {
      // Silently fail - don't want debug logging to break the app
    }
  }

  /** Log a debug message directly */
  log(message: string, data?: unknown) {
    console.warn(message, data ?? '');
  }

  /** Enable/disable debug logging */
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  /** Clear the debug log file on the server */
  async clear() {
    try {
      await fetch('/api/logs/debug', { method: 'DELETE' });
    } catch {
      // Ignore
    }
  }
}

// Singleton instance
export const debugLogger = new DebugLogger();

// Expose log export globally for easy access from console
if (typeof window !== 'undefined') {
  (window as unknown as { __latticeExportLogs: (minutes?: number) => void }).__latticeExportLogs = (minutes = 10) => {
    window.open(`/api/logs/export?minutes=${minutes}`, '_blank');
  };

  // Expose debug flag controls globally
  interface LatticeDebugAPI {
    enable: (flag: string) => void;
    disable: (flag: string) => void;
    toggle: (flag: string) => void;
    list: () => void;
    flags: Record<string, boolean>;
  }

  // eslint-disable-next-line no-console -- Debug API intentionally uses console.log for user feedback
  const log = console.log.bind(console);

  (window as unknown as { __latticeDebug: LatticeDebugAPI }).__latticeDebug = {
    enable(flag: string) {
      if (flag === 'all') {
        Object.keys(debugFlags).forEach(k => { debugFlags[k] = true; });
        log('[Debug] All flags enabled:', Object.keys(debugFlags).join(', '));
      } else if (flag in debugFlags) {
        debugFlags[flag] = true;
        log(`[Debug] Enabled: ${flag}`);
      } else {
        log(`[Debug] Unknown flag: ${flag}. Available: ${Object.keys(debugFlags).join(', ')}`);
      }
    },
    disable(flag: string) {
      if (flag === 'all') {
        Object.keys(debugFlags).forEach(k => { debugFlags[k] = false; });
        log('[Debug] All flags disabled');
      } else if (flag in debugFlags) {
        debugFlags[flag] = false;
        log(`[Debug] Disabled: ${flag}`);
      } else {
        log(`[Debug] Unknown flag: ${flag}. Available: ${Object.keys(debugFlags).join(', ')}`);
      }
    },
    toggle(flag: string) {
      if (flag in debugFlags) {
        debugFlags[flag] = !debugFlags[flag];
        log(`[Debug] ${flag}: ${debugFlags[flag] ? 'enabled' : 'disabled'}`);
      } else {
        log(`[Debug] Unknown flag: ${flag}. Available: ${Object.keys(debugFlags).join(', ')}`);
      }
    },
    list() {
      log('[Debug] Flags:', { ...debugFlags });
      log('Usage: __latticeDebug.enable("tooltips") or __latticeDebug.enable("all")');
    },
    flags: debugFlags,
  };
}
