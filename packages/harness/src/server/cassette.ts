/**
 * Cassette recording and replay for ProcessAdapter.
 *
 * Record real CLI sessions, replay them deterministically in tests.
 * Guarantees test event streams match real CLI output byte-for-byte (at the
 * line level — chunking fidelity is JsonLinesParser's concern).
 *
 * Recording: CassetteRecorder wraps any ProcessAdapter, tees stdout/stdin to
 * a JSONL recording while passing events through normally.
 *
 * Replay: CassetteAdapter implements ProcessAdapter, replaying a recording as
 * if a live process were emitting lines. Preserves real timing between stdout
 * events. At stdin markers, pauses until write() is called (skipping user
 * think-time — only CLI processing time after stdin is preserved).
 */

import type { ProcessAdapter, ProcessHandle, SpawnConfig } from './process-adapter.js'

// ---- Cassette entry types ----

export interface CassetteMeta {
  type: 'meta'
  ts: 0
  format: 1
}

export interface CassetteStdout {
  type: 'stdout'
  ts: number
  data: string
}

export interface CassetteStdin {
  type: 'stdin'
  ts: number
  data: string
}

export interface CassetteExit {
  type: 'exit'
  ts: number
  code: number
  signal?: string
}

export type CassetteEntry = CassetteMeta | CassetteStdout | CassetteStdin | CassetteExit

// ---- Serialization ----

export function serializeCassette(entries: CassetteEntry[]): string {
  return entries.map(e => JSON.stringify(e)).join('\n') + '\n'
}

export function parseCassette(content: string): CassetteEntry[] {
  return content
    .trim()
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as CassetteEntry)
}

// ---- CassetteRecorder ----

/**
 * Wraps a ProcessAdapter to record stdout, stdin, and exit events.
 * Use it as a drop-in replacement — it delegates to the inner adapter and
 * captures everything that flows through.
 *
 * After the session, retrieve the recording with `getRecording()`.
 */
export class CassetteRecorder implements ProcessAdapter {
  private inner: ProcessAdapter
  private recordings: CassetteEntry[][] = []

  constructor(inner: ProcessAdapter) {
    this.inner = inner
  }

  async spawn(config: SpawnConfig): Promise<ProcessHandle> {
    const entries: CassetteEntry[] = [{ type: 'meta', ts: 0, format: 1 }]
    const startTime = Date.now()
    this.recordings.push(entries)

    const handle = await this.inner.spawn(config)

    // Wrap stdout — record each line as it arrives
    const realStdout = handle.stdout
    const stdout: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        const iter = realStdout[Symbol.asyncIterator]()
        return {
          async next() {
            const result = await iter.next()
            if (!result.done) {
              entries.push({
                type: 'stdout',
                ts: Date.now() - startTime,
                data: result.value,
              })
            }
            return result
          },
        }
      },
    }

    // Wrap write — record stdin
    const realWrite = handle.write.bind(handle)
    const write = (input: string) => {
      entries.push({
        type: 'stdin',
        ts: Date.now() - startTime,
        data: input,
      })
      realWrite(input)
    }

    // Wrap exited — record exit
    const exited = handle.exited.then(result => {
      entries.push({
        type: 'exit',
        ts: Date.now() - startTime,
        code: result.code,
        signal: result.signal,
      })
      return result
    })

    return {
      stdout,
      write,
      signal: handle.signal.bind(handle),
      exited,
      get alive() { return handle.alive },
      pid: handle.pid,
      processId: handle.processId,
    }
  }

  /** Retrieve the recording from the nth spawn (default: most recent). */
  getRecording(index?: number): CassetteEntry[] {
    const i = index ?? this.recordings.length - 1
    return this.recordings[i] ?? []
  }

  get recordingCount(): number {
    return this.recordings.length
  }
}

// ---- CassetteAdapter (replay) ----

/**
 * Replays a cassette recording as a ProcessAdapter.
 *
 * Stdout lines are emitted with their original inter-event timing.
 * At stdin markers, playback pauses until write() is called — this skips
 * the original user think-time but preserves CLI processing time (the delay
 * from stdin to the next stdout event).
 *
 * No fallback: if no recording is provided, spawn() throws.
 */
export interface CassetteAdapterOptions {
  /** Multiplier for inter-event delays. Default 1.0 (real time).
   *  Use 0.01–0.1 for fast test playback. */
  timescale?: number
}

export class CassetteAdapter implements ProcessAdapter {
  private entries: CassetteEntry[]
  private timescale: number

  /** Stdin writes received during replay, for assertions. */
  readonly stdinWrites: string[] = []

  /** Signals received during replay, for assertions. */
  readonly signals: NodeJS.Signals[] = []

  constructor(entries: CassetteEntry[], options?: CassetteAdapterOptions) {
    if (entries.length === 0) {
      throw new Error('Cassette is empty — no recording to replay')
    }
    this.entries = entries
    this.timescale = options?.timescale ?? 1.0
  }

  static fromString(content: string, options?: CassetteAdapterOptions): CassetteAdapter {
    return new CassetteAdapter(parseCassette(content), options)
  }

  async spawn(_config: SpawnConfig): Promise<ProcessHandle> {
    const playbackEntries = this.entries.filter(e => e.type !== 'meta')
    const self = this

    let alive = true
    let done = false
    const lineBuffer: string[] = []
    let lineResolve: ((value: IteratorResult<string>) => void) | null = null
    let stdinGate: (() => void) | null = null
    let stdinIndex = 0
    let resolveExit!: (value: { code: number; signal?: string }) => void
    const exited = new Promise<{ code: number; signal?: string }>(resolve => {
      resolveExit = resolve
    })

    function emitLine(line: string) {
      if (lineResolve) {
        const resolve = lineResolve
        lineResolve = null
        resolve({ value: line, done: false })
      } else {
        lineBuffer.push(line)
      }
    }

    function endStream() {
      alive = false
      done = true
      if (lineResolve) {
        const resolve = lineResolve
        lineResolve = null
        resolve({ value: undefined as unknown as string, done: true })
      }
    }

    // Playback loop — runs asynchronously
    const playback = async () => {
      let lastTs = 0

      for (const entry of playbackEntries) {
        if (done) break

        if (entry.type === 'stdin') {
          // Don't apply the delay for stdin (skip user think-time).
          // Just wait for write() to be called.
          if (stdinIndex >= self.stdinWrites.length) {
            await new Promise<void>(resolve => { stdinGate = resolve })
          }
          stdinIndex++
          // Update lastTs so the delay to the NEXT event (stdout after stdin)
          // reflects real CLI processing time.
          lastTs = entry.ts
          continue
        }

        // Apply delay between events (real CLI timing, scaled for tests)
        const delay = Math.round((entry.ts - lastTs) * this.timescale)
        if (delay > 0) {
          await new Promise<void>(resolve => setTimeout(resolve, delay))
        }
        lastTs = entry.ts

        if (entry.type === 'stdout') {
          emitLine(entry.data)
        } else if (entry.type === 'exit') {
          endStream()
          resolveExit({ code: entry.code, signal: entry.signal })
          return
        }
      }

      // No explicit exit entry — end naturally
      if (!done) {
        endStream()
        resolveExit({ code: 0 })
      }
    }

    // Start playback (non-blocking)
    playback()

    const stdout: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            if (lineBuffer.length > 0) {
              return Promise.resolve({ value: lineBuffer.shift()!, done: false })
            }
            if (done) {
              return Promise.resolve({
                value: undefined as unknown as string,
                done: true,
              })
            }
            return new Promise(resolve => { lineResolve = resolve })
          },
        }
      },
    }

    return {
      stdout,
      write(input: string) {
        self.stdinWrites.push(input)
        if (stdinGate) {
          const gate = stdinGate
          stdinGate = null
          gate()
        }
      },
      signal(sig: NodeJS.Signals) {
        self.signals.push(sig)
      },
      exited,
      get alive() { return alive },
      pid: undefined,
    }
  }
}
