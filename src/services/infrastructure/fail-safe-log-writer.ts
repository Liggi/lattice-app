import * as fs from 'fs';

/**
 * Write to stderr without going through `process.stderr`. When stderr is a file
 * on a full disk, `process.stderr.write` emits an unhandled 'error' and the
 * process exits; this drops the text instead.
 */
export function writeStderrSafely(text: string): void {
  try {
    fs.writeSync(2, text);
  } catch {
    // Nowhere left to report it.
  }
}

/**
 * A pino destination that writes each line synchronously to a file (opened for
 * append on first write) or a file descriptor, and survives a failed open or
 * write (ENOSPC when the disk fills). The failed line is dropped, the first
 * failure is reported on stderr, and the first write that succeeds afterwards
 * reports how many lines were lost. Nothing is buffered, so a long outage costs
 * no memory and logging resumes as soon as writes succeed. A file is closed on
 * failure and reopened on the next write, so deleting it to free space works.
 */
export class FailSafeLogWriter {
  private fd: number | null;
  private readonly label: string;
  private failingSince: string | null = null;
  private droppedLines = 0;

  constructor(private readonly target: string | number) {
    this.fd = typeof target === 'number' ? target : null;
    this.label = typeof target === 'number' ? `fd ${target}` : target;
  }

  write(line: string): void {
    try {
      this.fd ??= fs.openSync(this.target as string, 'a');
      let pending = Buffer.from(line);
      while (pending.length > 0) {
        pending = pending.subarray(fs.writeSync(this.fd, pending));
      }
    } catch (err) {
      this.droppedLines += 1;
      if (typeof this.target === 'string' && this.fd !== null) {
        try {
          fs.closeSync(this.fd);
        } catch {
          // The fd is dropped either way.
        }
        this.fd = null;
      }
      if (this.failingSince === null) {
        this.failingSince = new Date().toISOString();
        const reason = err instanceof Error ? err.message : String(err);
        writeStderrSafely(`[logger] writes to ${this.label} are failing (${reason}); dropping log lines until a write succeeds\n`);
      }
      return;
    }
    if (this.failingSince !== null) {
      writeStderrSafely(`[logger] writes to ${this.label} resumed; ${this.droppedLines} log lines dropped since ${this.failingSince}\n`);
      this.failingSince = null;
      this.droppedLines = 0;
    }
  }
}
