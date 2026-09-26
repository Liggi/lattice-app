import { describe, it, expect } from 'vitest'
import { FakeProcess, FakeAdapter } from './fake-process.js'
import { INIT_EVENT, TEXT_ASSISTANT, RESULT_SUCCESS } from './fixtures.js'

describe('FakeProcess', () => {
  it('emits lines via the stdout async iterable', async () => {
    const fake = new FakeProcess()
    const lines: string[] = []

    const reader = (async () => {
      for await (const line of fake.stdout) {
        lines.push(line)
        if (lines.length === 2) break
      }
    })()

    fake.emitLine('line1')
    fake.emitLine('line2')
    await reader

    expect(lines).toEqual(['line1', 'line2'])
  })

  it('buffers lines emitted before reading starts', async () => {
    const fake = new FakeProcess()
    fake.emitLine('buffered1')
    fake.emitLine('buffered2')

    const lines: string[] = []
    const reader = (async () => {
      for await (const line of fake.stdout) {
        lines.push(line)
        if (lines.length === 2) break
      }
    })()

    await reader
    expect(lines).toEqual(['buffered1', 'buffered2'])
  })

  it('captures stdin writes', () => {
    const fake = new FakeProcess()
    fake.write('hello\n')
    fake.write('world\n')
    expect(fake.stdinWrites).toEqual(['hello\n', 'world\n'])
  })

  it('captures signals', () => {
    const fake = new FakeProcess()
    fake.signal('SIGINT')
    fake.signal('SIGTERM')
    expect(fake.signals).toEqual(['SIGINT', 'SIGTERM'])
  })

  it('exits and resolves the exited promise', async () => {
    const fake = new FakeProcess()
    expect(fake.alive).toBe(true)
    fake.exit(0)
    expect(fake.alive).toBe(false)
    const result = await fake.exited
    expect(result).toEqual({ code: 0, signal: undefined })
  })

  it('exits with signal', async () => {
    const fake = new FakeProcess()
    fake.exit(137, 'SIGKILL')
    const result = await fake.exited
    expect(result).toEqual({ code: 137, signal: 'SIGKILL' })
  })

  it('stdout iterator ends when process exits', async () => {
    const fake = new FakeProcess()
    fake.emitLine('one')

    const lines: string[] = []
    const reader = (async () => {
      for await (const line of fake.stdout) {
        lines.push(line)
      }
    })()

    // Let the reader consume the buffered line and start waiting
    await new Promise((r) => setTimeout(r, 10))
    fake.exit(0)
    await reader

    expect(lines).toEqual(['one'])
  })

  it('throws when emitting on a dead process', () => {
    const fake = new FakeProcess()
    fake.exit(0)
    expect(() => fake.emitLine('nope')).toThrow('Cannot emit on a dead process')
  })

  it('throws when writing to a dead process', () => {
    const fake = new FakeProcess()
    fake.exit(0)
    expect(() => fake.write('nope')).toThrow('Cannot write to a dead process')
  })

  it('simulates a full Claude CLI session', async () => {
    const fake = new FakeProcess()
    const lines: string[] = []

    const reader = (async () => {
      for await (const line of fake.stdout) {
        lines.push(line)
      }
    })()

    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    fake.exit(0)

    await reader

    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0]).type).toBe('system')
    expect(JSON.parse(lines[1]).type).toBe('assistant')
    expect(JSON.parse(lines[2]).type).toBe('result')
  })
})

describe('FakeAdapter', () => {
  it('spawns FakeProcess instances', async () => {
    const adapter = new FakeAdapter()
    const handle = await adapter.spawn({ prompt: 'test' })
    expect(handle.alive).toBe(true)
    expect(adapter.spawned).toHaveLength(1)
  })

  it('tracks multiple spawns', async () => {
    const adapter = new FakeAdapter()
    await adapter.spawn({ prompt: 'first' })
    await adapter.spawn({ prompt: 'second' })
    expect(adapter.spawned).toHaveLength(2)
  })

  it('latest returns the most recent process', async () => {
    const adapter = new FakeAdapter()
    await adapter.spawn({ prompt: 'first' })
    const second = await adapter.spawn({ prompt: 'second' })
    expect(adapter.latest).toBe(second)
  })

  it('rejects spawn when spawnError is set', async () => {
    const adapter = new FakeAdapter()
    adapter.spawnError = new Error('spawn ENOENT: claude')
    await expect(adapter.spawn({ prompt: 'test' })).rejects.toThrow('spawn ENOENT: claude')
  })

  it('calls onSpawn with config', async () => {
    const adapter = new FakeAdapter()
    const configs: unknown[] = []
    adapter.onSpawn = (config) => configs.push(config)

    await adapter.spawn({ prompt: 'hello', cwd: '/tmp' })
    expect(configs).toEqual([{ prompt: 'hello', cwd: '/tmp' }])
  })
})
