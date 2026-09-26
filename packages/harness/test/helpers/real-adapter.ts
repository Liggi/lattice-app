import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProcessAdapter, ProcessHandle, SpawnConfig } from '../../src/server/process-adapter.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MOCK_CLI_PATH = resolve(__dirname, 'mock-cli.mjs')

/**
 * A real ProcessAdapter that spawns the mock CLI script.
 * Exercises the actual ProcessHandle interface with a real child process.
 */
export class RealAdapter implements ProcessAdapter {
  async spawn(_config: SpawnConfig): Promise<ProcessHandle> {
    const proc = spawn('node', [MOCK_CLI_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let alive = true

    const exitPromise = new Promise<{ code: number; signal?: string }>((resolve) => {
      proc.on('exit', (code, signal) => {
        alive = false
        resolve({ code: code ?? 1, signal: signal ?? undefined })
      })
    })

    const rl = createInterface({ input: proc.stdout! })
    const lineBuffer: string[] = []
    let lineResolve: ((result: IteratorResult<string>) => void) | null = null

    rl.on('line', (line) => {
      if (lineResolve) {
        const resolve = lineResolve
        lineResolve = null
        resolve({ value: line, done: false })
      } else {
        lineBuffer.push(line)
      }
    })

    rl.on('close', () => {
      if (lineResolve) {
        const resolve = lineResolve
        lineResolve = null
        resolve({ value: undefined as unknown as string, done: true })
      }
    })

    const stdout: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            if (lineBuffer.length > 0) {
              return Promise.resolve({ value: lineBuffer.shift()!, done: false })
            }
            if (!alive) {
              return Promise.resolve({ value: undefined as unknown as string, done: true })
            }
            return new Promise((resolve) => {
              lineResolve = resolve
            })
          },
        }
      },
    }

    return {
      stdout,
      write(input: string) {
        proc.stdin!.write(input)
      },
      signal(sig: NodeJS.Signals) {
        proc.kill(sig)
      },
      exited: exitPromise,
      get alive() {
        return alive
      },
      pid: proc.pid,
    }
  }
}
