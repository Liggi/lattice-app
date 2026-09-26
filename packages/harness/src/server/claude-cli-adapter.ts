/**
 * ProcessAdapter that spawns the real Claude CLI.
 *
 * Uses `--print --output-format stream-json` for single-turn sessions.
 * The stdout stream yields one JSON line per CLI event — same format the
 * harness expects from any ProcessAdapter.
 */

import { spawn } from 'node:child_process'
import { lineStream } from './line-stream.js'
import type { ProcessAdapter, ProcessHandle, SpawnConfig } from './process-adapter.js'

export class ClaudeCliAdapter implements ProcessAdapter {
  async spawn(config: SpawnConfig): Promise<ProcessHandle> {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      ...(config.args ?? []),
      config.prompt,
    ]

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
    })

    let alive = true

    const exitPromise = new Promise<{ code: number; signal?: string }>((resolve) => {
      proc.on('exit', (code, signal) => {
        alive = false
        resolve({ code: code ?? 1, signal: signal ?? undefined })
      })
    })

    const stdout = lineStream(proc.stdout!)

    return {
      stdout,
      write(input: string) {
        proc.stdin!.write(input)
      },
      signal(sig: NodeJS.Signals) {
        proc.kill(sig)
      },
      exited: exitPromise,
      get alive() { return alive },
      pid: proc.pid,
    }
  }
}
