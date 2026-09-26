import type {
  ProcessAdapter,
  ProcessHandle,
  SpawnConfig,
} from '../../src/server/process-adapter.js'

/**
 * A programmable process handle for testing. Gives tests full synchronous
 * control over stdout, stdin capture, signal capture, and exit behavior.
 */
export class FakeProcess implements ProcessHandle {
  readonly stdinWrites: string[] = []
  /** The `extra` bag accompanying each stdin write, index-aligned with
   *  stdinWrites. Undefined where the caller passed none. */
  readonly stdinExtras: (Record<string, unknown> | undefined)[] = []
  readonly signals: NodeJS.Signals[] = []
  alive = true
  pid = 9999

  private lineBuffer: string[] = []
  private lineResolve: ((value: IteratorResult<string>) => void) | null = null
  private exitResolve!: (value: { code: number; signal?: string }) => void
  readonly exited: Promise<{ code: number; signal?: string }>

  constructor() {
    this.exited = new Promise((resolve) => {
      this.exitResolve = resolve
    })
  }

  /** Emit a line on stdout (as if the process printed it). */
  emitLine(line: string): void {
    if (!this.alive) throw new Error('Cannot emit on a dead process')
    if (this.lineResolve) {
      const resolve = this.lineResolve
      this.lineResolve = null
      resolve({ value: line, done: false })
    } else {
      this.lineBuffer.push(line)
    }
  }

  /** Write to the process stdin. Captured in stdinWrites (and stdinExtras) for assertions. */
  write(input: string, extra?: Record<string, unknown>): void {
    if (!this.alive) throw new Error('Cannot write to a dead process')
    this.stdinWrites.push(input)
    this.stdinExtras.push(extra)
  }

  /** Send a signal. Captured in signals for assertions. */
  signal(sig: NodeJS.Signals): void {
    this.signals.push(sig)
  }

  /** Exit the process with a code. Resolves the exited promise. */
  exit(code: number, signal?: string): void {
    if (!this.alive) throw new Error('Process already exited')
    this.alive = false
    // Flush any pending line reader
    if (this.lineResolve) {
      const resolve = this.lineResolve
      this.lineResolve = null
      resolve({ value: undefined as unknown as string, done: true })
    }
    this.exitResolve({ code, signal })
  }

  /** AsyncIterable<string> for stdout lines. */
  get stdout(): AsyncIterable<string> {
    const self = this
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            // Return buffered line immediately
            if (self.lineBuffer.length > 0) {
              return Promise.resolve({
                value: self.lineBuffer.shift()!,
                done: false,
              })
            }
            // If process is dead, we're done
            if (!self.alive) {
              return Promise.resolve({
                value: undefined as unknown as string,
                done: true,
              })
            }
            // Wait for next line
            return new Promise((resolve) => {
              self.lineResolve = resolve
            })
          },
        }
      },
    }
  }
}

/**
 * A test adapter that creates FakeProcess instances and maps them by
 * the sessionId passed in the config (via a naming convention).
 */
export class FakeAdapter implements ProcessAdapter {
  /** All spawned processes, keyed by the order they were spawned. */
  readonly spawned: FakeProcess[] = []

  /** Optional: make spawn reject with this error. */
  spawnError: Error | null = null

  /** Optional: called on each spawn with the config. */
  onSpawn?: (config: SpawnConfig) => void

  async spawn(config: SpawnConfig): Promise<ProcessHandle> {
    if (this.spawnError) throw this.spawnError
    const fake = new FakeProcess()
    this.spawned.push(fake)
    this.onSpawn?.(config)
    return fake
  }

  /** Get the most recently spawned process. */
  get latest(): FakeProcess {
    if (this.spawned.length === 0) throw new Error('No processes spawned')
    return this.spawned[this.spawned.length - 1]
  }
}
