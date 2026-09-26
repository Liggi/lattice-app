/**
 * ProcessAdapter that runs the Claude CLI as a keep-alive process, speaking
 * `stream-json` in both directions.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lineStream } from './line-stream.js'
import type { ProcessAdapter, ProcessHandle, SpawnConfig } from './process-adapter.js'

/**
 * Env keys stripped from the child by default.
 *
 * `NODE_OPTIONS` and `VSCODE_INSPECTOR_OPTIONS` would otherwise attach a
 * debugger to the spawned CLI when the host server itself runs under one.
 * `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` are set when the host is itself
 * running inside Claude Code, and make the child think it is a nested session.
 */
export const DEFAULT_STRIPPED_ENV_KEYS = [
  'NODE_OPTIONS',
  'VSCODE_INSPECTOR_OPTIONS',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
]

export interface ClaudeInteractiveAdapterOptions {
  /** Path to the `claude` executable. Defaults to `findClaudeBin()`. */
  claudeBin?: string
  /**
   * Adds `--dangerously-skip-permissions`, which lets the CLI run every tool
   * — including file writes and arbitrary shell commands — with no approval
   * prompt and no allowlist.
   *
   * Off by default, and it should stay off anywhere the agent's working
   * directory is a real machine you care about. Only turn it on for sandboxed
   * or containerized deployments where the blast radius of an arbitrary
   * command is a disposable environment.
   */
  skipPermissions?: boolean
  /** Extra CLI arguments, appended after the adapter's own flags. */
  extraArgs?: string[]
  /** Env vars merged into the child's environment. `SpawnConfig.env` wins. */
  env?: Record<string, string>
  /** Overrides {@link DEFAULT_STRIPPED_ENV_KEYS}. Pass `[]` to strip nothing. */
  stripEnvKeys?: string[]
}

/**
 * Locates the `claude` executable: `CLAUDE_BIN` if set, then the usual install
 * locations, then a `PATH` scan. `node_modules` directories on `PATH` are
 * skipped — a locally installed shim there is usually not the real CLI.
 */
export function findClaudeBin(): string {
  if (process.env.CLAUDE_BIN) return path.resolve(process.env.CLAUDE_BIN)

  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  const pathDirs = (process.env.PATH ?? '').split(path.delimiter)
  for (const dir of pathDirs) {
    if (!dir || dir.includes('node_modules')) continue
    const candidate = path.join(dir, 'claude')
    if (existsSync(candidate)) return candidate
  }

  throw new Error('Claude CLI not found. Install @anthropic-ai/claude-code, or set CLAUDE_BIN.')
}

/**
 * Builds the `content` field of a stdin message. With content blocks present
 * (images, documents) this is an array of blocks with the text appended;
 * otherwise it is the bare text string.
 */
function buildStdinContent(text: string, contentBlocks?: unknown[]): string | unknown[] {
  if (!contentBlocks || contentBlocks.length === 0) return text
  return [...contentBlocks, ...(text ? [{ type: 'text', text }] : [])]
}

function encodeUserMessage(text: string, contentBlocks?: unknown[]): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: buildStdinContent(text, contentBlocks) },
  }) + '\n'
}

/**
 * ProcessAdapter that keeps one Claude CLI process alive across turns.
 *
 * Spawns `claude --output-format stream-json --input-format stream-json
 * --verbose`. The `--input-format stream-json` flag is what makes this
 * keep-alive: instead of running one turn and exiting, the CLI sits reading
 * JSON user messages from stdin, so a follow-up is a stdin write rather than a
 * respawn, and conversation state never has to be rebuilt with `--resume`.
 *
 * The initial prompt goes in over stdin too, *not* via `-p`. Passing `-p`
 * alongside piped stdin makes the CLI block waiting for stdin before it
 * processes the prompt.
 *
 * Keep-alive semantics pair with `SessionManager.stop()`: its escalation starts
 * with `SIGINT`, which this adapter turns into the CLI's stdin interrupt
 * request (a real SIGINT ends the turn and then exits the CLI). If the CLI
 * responds with a `turn:end`, SessionManager stops escalating and the process
 * stays up, ready for the next message — interrupt without losing the session.
 * `SIGTERM`/`SIGKILL` are only reached when the CLI does not respond, and this
 * adapter routes those to the whole process group so the CLI's own children go
 * with it.
 *
 * There is no PTY here, despite "interactive" in the name. `stream-json` is
 * newline-delimited JSON on a pipe and needs no terminal at all, and a PTY
 * would actively hurt: it re-introduces ANSI escape sequences, terminal write
 * buffering, and line wrapping at the terminal width — three ways to corrupt a
 * JSON line that piped stdio simply does not have.
 */
export class ClaudeInteractiveAdapter implements ProcessAdapter {
  private readonly options: ClaudeInteractiveAdapterOptions
  private resolvedBin: string | null

  constructor(options: ClaudeInteractiveAdapterOptions = {}) {
    this.options = options
    this.resolvedBin = options.claudeBin ?? null
  }

  private get claudeBin(): string {
    if (!this.resolvedBin) this.resolvedBin = findClaudeBin()
    return this.resolvedBin
  }

  private buildEnv(configEnv?: Record<string, string>): NodeJS.ProcessEnv {
    const stripped = new Set(this.options.stripEnvKeys ?? DEFAULT_STRIPPED_ENV_KEYS)
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string' && !stripped.has(key)) env[key] = value
    }
    Object.assign(env, this.options.env ?? {}, configEnv ?? {})
    return env as NodeJS.ProcessEnv
  }

  async spawn(config: SpawnConfig): Promise<ProcessHandle> {
    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
    ]

    if (this.options.skipPermissions) args.push('--dangerously-skip-permissions')
    if (config.resume) args.push('--resume', config.resume)
    if (this.options.extraArgs) args.push(...this.options.extraArgs)
    if (config.args) args.push(...config.args)

    // Detaching gives the child its own process group, so a kill can take the
    // CLI's descendants (shells it spawned, MCP servers) with it. Windows has
    // no process groups to signal, so it stays attached there.
    const useProcessGroup = process.platform !== 'win32'

    const child = nodeSpawn(this.claudeBin, args, {
      cwd: config.cwd ?? process.cwd(),
      env: this.buildEnv(config.env),
      stdio: 'pipe',
      detached: useProcessGroup,
    })

    let alive = true
    const exited = new Promise<{ code: number; signal?: string }>((resolve) => {
      child.on('exit', (code, signal) => {
        alive = false
        resolve({ code: code ?? 1, signal: signal ?? undefined })
      })
    })

    const stdout = lineStream(child.stdout!)

    // The CLI is already waiting on stdin — nothing happens until the first
    // stream-json user message arrives.
    if (config.prompt) {
      const blocks = config.extra?.contentBlocks as unknown[] | undefined
      child.stdin!.write(encodeUserMessage(config.prompt, blocks))
    }

    return {
      stdout,
      write(input: string, extra?: Record<string, unknown>) {
        // SessionManager.send() appends a newline for line-oriented adapters.
        // Here the framing is the JSON envelope, so drop it rather than send a
        // user message whose text ends in a stray blank line.
        const text = input.endsWith('\n') ? input.slice(0, -1) : input
        const blocks = extra?.contentBlocks as unknown[] | undefined
        child.stdin!.write(encodeUserMessage(text, blocks))
      },
      signal(sig: NodeJS.Signals) {
        if (sig === 'SIGINT') {
          if (alive) child.stdin!.write(JSON.stringify({
            type: 'control_request',
            request_id: `interrupt-${randomUUID()}`,
            request: { subtype: 'interrupt' },
          }) + '\n')
          return
        }
        if (useProcessGroup && child.pid && (sig === 'SIGTERM' || sig === 'SIGKILL')) {
          try {
            process.kill(-child.pid, sig)
            return
          } catch (err) {
            // ESRCH: the group is already gone. Anything else is real.
            if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
          }
        }
        child.kill(sig)
      },
      exited,
      get alive() { return alive },
      pid: child.pid,
    }
  }
}
