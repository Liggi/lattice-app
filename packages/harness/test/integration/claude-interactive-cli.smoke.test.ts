/**
 * Opt-in smoke test against the REAL Claude CLI.
 *
 * Skipped unless `RUN_CLI_TESTS=1`, because it spawns the actual `claude`
 * binary and spends real tokens. Everything else in the suite is hermetic.
 *
 *   RUN_CLI_TESTS=1 npx vitest run test/integration/claude-interactive-cli.smoke.test.ts
 *
 * What it proves, and nothing else: that ClaudeInteractiveAdapter's flags and
 * stdin framing are still what the installed CLI expects, and that a follow-up
 * really is served by the same process rather than a respawn. That second part
 * is the whole point of the adapter, and it is exactly the thing a unit test
 * against a fixture script cannot establish.
 *
 * No ANTHROPIC_API_KEY needed — headless stream-json runs on the existing
 * Claude Code login.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../../src/server/session-manager.js'
import { ClaudeInteractiveAdapter } from '../../src/server/claude-interactive-adapter.js'
import type { ProcessAdapter, ProcessHandle, SpawnConfig } from '../../src/server/process-adapter.js'
import type { SessionEvent } from '../../src/protocol/events.js'

const ENABLED = process.env.RUN_CLI_TESTS === '1'
const TIMEOUT_MS = 300_000

/** Wraps the adapter to count spawns and keep every handle it produced. */
class SpawnCountingAdapter implements ProcessAdapter {
  readonly handles: ProcessHandle[] = []
  constructor(private readonly inner: ProcessAdapter) {}
  async spawn(config: SpawnConfig): Promise<ProcessHandle> {
    const handle = await this.inner.spawn(config)
    this.handles.push(handle)
    return handle
  }
}

function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = setInterval(() => {
      if (check()) {
        clearInterval(tick)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(tick)
        reject(new Error(`timed out waiting for ${label}`))
      }
    }, 100)
  })
}

const countOf = (events: SessionEvent[], type: string) =>
  events.filter((e) => e.type === type).length

let cleanup: (() => void) | null = null

afterEach(() => {
  cleanup?.()
  cleanup = null
})

describe.skipIf(!ENABLED)('real Claude CLI — keep-alive smoke (RUN_CLI_TESTS=1)', () => {
  it(
    'serves a follow-up from the same process, no respawn',
    async () => {
      const workdir = mkdtempSync(join(tmpdir(), 'harness-smoke-'))
      const adapter = new SpawnCountingAdapter(new ClaudeInteractiveAdapter())
      const manager = new SessionManager(adapter)

      cleanup = () => {
        for (const handle of adapter.handles) {
          if (handle.alive) handle.signal('SIGKILL')
        }
        rmSync(workdir, { recursive: true, force: true })
      }

      await manager.start('smoke', {
        prompt: 'Reply with the single word: ok',
        cwd: workdir,
      })

      const log = () => manager.getLog('smoke')!.all()

      await waitFor(() => log().some((e) => e.type === 'run:ready'), TIMEOUT_MS, 'run:ready')
      await waitFor(() => log().some((e) => e.type === 'content'), TIMEOUT_MS, 'content')
      await waitFor(() => countOf(log(), 'turn:end') >= 1, TIMEOUT_MS, 'first turn:end')

      // Keep-alive: the CLI is idle but still running between turns.
      expect(manager.getStatus('smoke')).toBe('idle')
      const pidAfterFirstTurn = manager.inspect('smoke')!.pid
      expect(pidAfterFirstTurn).toBeGreaterThan(0)
      expect(manager.inspect('smoke')!.processAlive).toBe(true)

      // Follow-up goes down the live process's stdin.
      await manager.send('smoke', 'Reply with the single word: two')
      await waitFor(() => countOf(log(), 'turn:end') >= 2, TIMEOUT_MS, 'second turn:end')

      // The evidence that this is keep-alive and not a resumed respawn:
      // one spawn, one pid, one run:start for two completed turns.
      expect(adapter.handles).toHaveLength(1)
      expect(manager.inspect('smoke')!.pid).toBe(pidAfterFirstTurn)
      expect(countOf(log(), 'run:start')).toBe(1)
      expect(countOf(log(), 'run:end')).toBe(0)
      expect(countOf(log(), 'input:sent')).toBe(2)

      const runIds = new Set(log().map((e) => e.runId))
      expect(runIds.size).toBe(1)

      // Printed so a smoke run leaves readable evidence, not just a green tick.
      console.log(
        `[smoke] spawns=${adapter.handles.length} ` +
          `pid=${pidAfterFirstTurn}->${manager.inspect('smoke')!.pid} ` +
          `runs=${countOf(log(), 'run:start')} turns=${countOf(log(), 'turn:end')} ` +
          `apiKey=${process.env.ANTHROPIC_API_KEY ? 'set' : 'unset'}`,
      )

      await manager.stop('smoke')
      await waitFor(() => !manager.inspect('smoke')!.processAlive, 30_000, 'process exit')
    },
    TIMEOUT_MS,
  )
})
