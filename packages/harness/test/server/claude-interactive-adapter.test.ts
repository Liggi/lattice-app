/**
 * ClaudeInteractiveAdapter unit tests.
 *
 * These spawn a real child process, but not the real CLI: `claudeBin` points
 * at test/helpers/echo-cli.mjs, which reports its argv, env and stdin back as
 * JSON lines. That keeps the adapter's actual spawn path under test — argv
 * assembly, env cleaning, stdin framing, the lineStream reader — with no
 * network, no API key and no mocking of node:child_process.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ClaudeInteractiveAdapter,
  DEFAULT_STRIPPED_ENV_KEYS,
  findClaudeBin,
} from '../../src/server/claude-interactive-adapter.js'
import type { ProcessHandle, SpawnConfig } from '../../src/server/process-adapter.js'

const ECHO_CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../helpers/echo-cli.mjs')

const live: ProcessHandle[] = []

afterEach(() => {
  for (const handle of live.splice(0)) {
    if (handle.alive) handle.signal('SIGKILL')
  }
})

async function launch(
  config: Partial<SpawnConfig> = {},
  options: ConstructorParameters<typeof ClaudeInteractiveAdapter>[0] = {},
) {
  const adapter = new ClaudeInteractiveAdapter({ claudeBin: ECHO_CLI, ...options })
  const handle = await adapter.spawn({ prompt: 'hello', ...config })
  live.push(handle)
  return handle
}

/** Reads stdout until a line of the given kind arrives (or the stream ends). */
async function readKind(handle: ProcessHandle, kind: string, skip = 0): Promise<any> {
  let seen = 0
  for await (const line of handle.stdout) {
    const parsed = JSON.parse(line)
    if (parsed.kind !== kind) continue
    if (seen++ < skip) continue
    return parsed
  }
  throw new Error(`stream ended before a "${kind}" line (skip=${skip})`)
}

const argvOf = (handle: ProcessHandle) => readKind(handle, 'argv').then((l) => l.argv as string[])
const envOf = (handle: ProcessHandle) =>
  readKind(handle, 'env').then((l) => l as { keys: string[]; values: Record<string, string> })
const stdinOf = (handle: ProcessHandle, skip = 0) =>
  readKind(handle, 'stdin', skip).then((l) => JSON.parse(l.raw as string))

describe('ClaudeInteractiveAdapter — argument construction', () => {
  it('always requests stream-json in both directions, plus --verbose', async () => {
    const argv = await argvOf(await launch())
    expect(argv.slice(0, 5)).toEqual([
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
    ])
  })

  it('does NOT pass --dangerously-skip-permissions by default', async () => {
    const argv = await argvOf(await launch())
    expect(argv).not.toContain('--dangerously-skip-permissions')
  })

  it('passes --dangerously-skip-permissions only when skipPermissions is true', async () => {
    const argv = await argvOf(await launch({}, { skipPermissions: true }))
    expect(argv).toContain('--dangerously-skip-permissions')
  })

  it('adds --resume <id> when config.resume is set', async () => {
    const argv = await argvOf(await launch({ resume: 'sess-abc-123' }))
    expect(argv).toContain('--resume')
    expect(argv[argv.indexOf('--resume') + 1]).toBe('sess-abc-123')
  })

  it('omits --resume when config.resume is absent', async () => {
    const argv = await argvOf(await launch())
    expect(argv).not.toContain('--resume')
  })

  it('appends extraArgs from options', async () => {
    const argv = await argvOf(await launch({}, { extraArgs: ['--model', 'sonnet'] }))
    expect(argv.slice(-2)).toEqual(['--model', 'sonnet'])
  })

  it('appends config.args, after options.extraArgs', async () => {
    const argv = await argvOf(
      await launch({ args: ['--from-config'] }, { extraArgs: ['--from-options'] }),
    )
    expect(argv.indexOf('--from-options')).toBeLessThan(argv.indexOf('--from-config'))
    expect(argv[argv.length - 1]).toBe('--from-config')
  })

  it('never passes the prompt as an argv element (it goes over stdin)', async () => {
    const argv = await argvOf(await launch({ prompt: 'the-prompt-text' }))
    expect(argv).not.toContain('the-prompt-text')
    expect(argv).not.toContain('-p')
    expect(argv).not.toContain('--print')
  })
})

describe('ClaudeInteractiveAdapter — stdin framing', () => {
  it('sends the initial prompt as a stream-json user message', async () => {
    const handle = await launch({ prompt: 'what changed?' })
    expect(await stdinOf(handle)).toEqual({
      type: 'user',
      message: { role: 'user', content: 'what changed?' },
    })
  })

  it('sends nothing on spawn when there is no prompt', async () => {
    const handle = await launch({ prompt: '' })
    handle.write('first real message')
    expect(await stdinOf(handle)).toEqual({
      type: 'user',
      message: { role: 'user', content: 'first real message' },
    })
  })

  it('strips the single trailing newline SessionManager.send() appends', async () => {
    const handle = await launch({ prompt: '' })
    handle.write('follow up\n')
    const msg = await stdinOf(handle)
    expect(msg.message.content).toBe('follow up')
  })

  it('strips only one trailing newline, preserving deliberate blank lines', async () => {
    const handle = await launch({ prompt: '' })
    handle.write('line one\n\n')
    const msg = await stdinOf(handle)
    expect(msg.message.content).toBe('line one\n')
  })

  it('leaves input without a trailing newline untouched', async () => {
    const handle = await launch({ prompt: '' })
    handle.write('no newline here')
    const msg = await stdinOf(handle)
    expect(msg.message.content).toBe('no newline here')
  })

  it('keeps the process alive across turns — a second write is served too', async () => {
    const handle = await launch({ prompt: 'first' })
    handle.write('second\n')
    expect((await stdinOf(handle, 0)).message.content).toBe('first')
    expect((await stdinOf(handle, 0)).message.content).toBe('second')
    expect(handle.alive).toBe(true)
  })

  it('turns extra.contentBlocks on spawn into array content, blocks before text', async () => {
    const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }
    const handle = await launch({ prompt: 'describe this', extra: { contentBlocks: [block] } })
    const msg = await stdinOf(handle)
    expect(msg.message.content).toEqual([block, { type: 'text', text: 'describe this' }])
  })

  it('turns extra.contentBlocks on write() into array content, blocks before text', async () => {
    const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBB' } }
    const handle = await launch({ prompt: '' })
    handle.write('and this one\n', { contentBlocks: [block] })
    const msg = await stdinOf(handle)
    expect(msg.message.content).toEqual([block, { type: 'text', text: 'and this one' }])
  })

  it('omits the text block entirely when content blocks are sent with empty text', async () => {
    const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'CCC' } }
    const handle = await launch({ prompt: '' })
    handle.write('\n', { contentBlocks: [block] })
    const msg = await stdinOf(handle)
    expect(msg.message.content).toEqual([block])
  })

  it('sends a plain string when contentBlocks is present but empty', async () => {
    const handle = await launch({ prompt: '', extra: { contentBlocks: [] } })
    handle.write('plain\n', { contentBlocks: [] })
    const msg = await stdinOf(handle)
    expect(msg.message.content).toBe('plain')
  })

  it('frames each message as exactly one newline-terminated JSON line', async () => {
    const handle = await launch({ prompt: 'multi\nline\nprompt' })
    const msg = await stdinOf(handle)
    expect(msg.message.content).toBe('multi\nline\nprompt')
  })
})

describe('ClaudeInteractiveAdapter — environment', () => {
  const stash = new Map<string, string | undefined>()

  function setEnv(key: string, value: string) {
    if (!stash.has(key)) stash.set(key, process.env[key])
    process.env[key] = value
  }

  afterEach(() => {
    for (const [key, value] of stash) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    stash.clear()
  })

  // A value that is harmless if a test deliberately lets NODE_OPTIONS through:
  // node refuses to start at all on an unrecognised NODE_OPTIONS.
  const SAFE_NODE_OPTIONS = '--max-old-space-size=512'

  it('strips the four default keys from the child environment', async () => {
    for (const key of DEFAULT_STRIPPED_ENV_KEYS) {
      setEnv(key, key === 'NODE_OPTIONS' ? SAFE_NODE_OPTIONS : 'set-in-parent')
    }
    const env = await envOf(await launch())
    for (const key of DEFAULT_STRIPPED_ENV_KEYS) {
      expect(env.keys).not.toContain(key)
    }
  })

  it('passes through unrelated parent env vars', async () => {
    setEnv('HARNESS_TEST_PASSTHROUGH', 'kept')
    const env = await envOf(await launch())
    expect(env.values.HARNESS_TEST_PASSTHROUGH).toBe('kept')
  })

  it('honours a custom stripEnvKeys list instead of the defaults', async () => {
    setEnv('NODE_OPTIONS', SAFE_NODE_OPTIONS)
    setEnv('HARNESS_TEST_SECRET', 'strip-me')
    const env = await envOf(await launch({}, { stripEnvKeys: ['HARNESS_TEST_SECRET'] }))
    expect(env.keys).not.toContain('HARNESS_TEST_SECRET')
    // The defaults are replaced, not extended.
    expect(env.keys).toContain('NODE_OPTIONS')
  })

  it('strips nothing when stripEnvKeys is an empty array', async () => {
    setEnv('CLAUDECODE', '1')
    const env = await envOf(await launch({}, { stripEnvKeys: [] }))
    expect(env.keys).toContain('CLAUDECODE')
  })

  it('merges options.env into the child environment', async () => {
    const env = await envOf(await launch({}, { env: { HARNESS_TEST_FROM_OPTIONS: 'yes' } }))
    expect(env.values.HARNESS_TEST_FROM_OPTIONS).toBe('yes')
  })

  it('merges config.env into the child environment', async () => {
    const env = await envOf(await launch({ env: { HARNESS_TEST_FROM_CONFIG: 'yes' } }))
    expect(env.values.HARNESS_TEST_FROM_CONFIG).toBe('yes')
  })

  it('lets per-spawn config.env win over adapter-level options.env', async () => {
    const env = await envOf(
      await launch(
        { env: { HARNESS_TEST_WINNER: 'config' } },
        { env: { HARNESS_TEST_WINNER: 'options' } },
      ),
    )
    expect(env.values.HARNESS_TEST_WINNER).toBe('config')
  })

  it('can reinstate a stripped key explicitly via config.env', async () => {
    setEnv('CLAUDECODE', '1')
    const env = await envOf(await launch({ env: { CLAUDECODE: 'forced' } }))
    expect(env.keys).toContain('CLAUDECODE')
  })
})

describe('ClaudeInteractiveAdapter — process handle', () => {
  it('reports a pid and stays alive after the first message', async () => {
    const handle = await launch({ prompt: 'hi' })
    await stdinOf(handle)
    expect(handle.pid).toBeGreaterThan(0)
    expect(handle.alive).toBe(true)
  })

  it('resolves exited and flips alive once the process is signalled', async () => {
    const handle = await launch({ prompt: 'hi' })
    await stdinOf(handle)
    handle.signal('SIGTERM')
    const result = await handle.exited
    expect(handle.alive).toBe(false)
    expect(result.signal ?? result.code).toBeDefined()
  })

  it('cancels a turn with the stdin interrupt request, leaving the process running', async () => {
    const handle = await launch({ prompt: 'hi' })
    handle.signal('SIGINT')
    const request = await stdinOf(handle, 1)
    expect(request).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } })
    expect(handle.alive).toBe(true)
  })

  it('does not throw when signalling an already-dead process group', async () => {
    const handle = await launch({ prompt: 'hi' })
    handle.signal('SIGKILL')
    await handle.exited
    expect(() => handle.signal('SIGKILL')).not.toThrow()
  })

  it('runs the child in config.cwd', async () => {
    const handle = await launch({ cwd: '/' })
    const { cwd } = await readKind(handle, 'cwd')
    expect(cwd).toBe('/')
  })
})

describe('findClaudeBin', () => {
  const stashed = process.env.CLAUDE_BIN

  afterEach(() => {
    if (stashed === undefined) delete process.env.CLAUDE_BIN
    else process.env.CLAUDE_BIN = stashed
  })

  it('resolves CLAUDE_BIN to an absolute path when set', () => {
    process.env.CLAUDE_BIN = ECHO_CLI
    expect(findClaudeBin()).toBe(ECHO_CLI)
  })

  it('is not called when claudeBin is supplied', async () => {
    process.env.CLAUDE_BIN = '/definitely/not/here/claude'
    const handle = await launch()
    expect(handle.pid).toBeGreaterThan(0)
  })
})
