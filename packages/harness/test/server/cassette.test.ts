import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FakeProcess, FakeAdapter } from '../helpers/fake-process.js'
import {
  CassetteRecorder,
  CassetteAdapter,
  serializeCassette,
  parseCassette,
} from '../../src/server/cassette.js'
import { SessionManager } from '../../src/server/session-manager.js'
import type { CassetteEntry } from '../../src/server/cassette.js'
import {
  INIT_EVENT,
  TEXT_ASSISTANT,
  RESULT_SUCCESS,
} from '../helpers/fixtures.js'

// ---- Helpers ----

function makeRecording(entries: CassetteEntry[]): CassetteEntry[] {
  return [{ type: 'meta', ts: 0, format: 1 }, ...entries]
}

function simpleRecording(): CassetteEntry[] {
  return makeRecording([
    { type: 'stdout', ts: 10, data: JSON.stringify(INIT_EVENT) },
    { type: 'stdout', ts: 50, data: JSON.stringify(TEXT_ASSISTANT) },
    { type: 'stdout', ts: 100, data: JSON.stringify(RESULT_SUCCESS) },
    { type: 'exit', ts: 200, code: 0 },
  ])
}

function multiTurnRecording(): CassetteEntry[] {
  return makeRecording([
    { type: 'stdout', ts: 10, data: JSON.stringify(INIT_EVENT) },
    { type: 'stdout', ts: 50, data: JSON.stringify(TEXT_ASSISTANT) },
    { type: 'stdout', ts: 100, data: JSON.stringify(RESULT_SUCCESS) },
    // User thinks for 5s, then sends follow-up
    { type: 'stdin', ts: 5000, data: '{"type":"user","message":{"role":"user","content":"follow-up"}}' },
    // CLI responds 80ms after receiving input
    { type: 'stdout', ts: 5080, data: JSON.stringify(TEXT_ASSISTANT) },
    { type: 'stdout', ts: 5150, data: JSON.stringify(RESULT_SUCCESS) },
    { type: 'exit', ts: 8000, code: 0 },
  ])
}

// ---- Serialization ----

describe('serializeCassette / parseCassette', () => {
  it('round-trips entries through JSONL', () => {
    const entries = simpleRecording()
    const serialized = serializeCassette(entries)
    const parsed = parseCassette(serialized)
    expect(parsed).toEqual(entries)
  })

  it('handles empty lines in serialized content', () => {
    const entries = simpleRecording()
    const serialized = serializeCassette(entries)
    // Add some blank lines
    const withBlanks = '\n' + serialized + '\n\n'
    const parsed = parseCassette(withBlanks)
    expect(parsed).toEqual(entries)
  })
})

// ---- CassetteRecorder ----

describe('CassetteRecorder', () => {
  it('records stdout lines from a FakeProcess', async () => {
    const fakeAdapter = new FakeAdapter()
    const recorder = new CassetteRecorder(fakeAdapter)

    const handle = await recorder.spawn({ prompt: 'hello' })

    // Emit some lines on the fake process
    const fake = fakeAdapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))

    // Consume stdout (recording happens on iteration)
    const lines: string[] = []
    const iter = handle.stdout[Symbol.asyncIterator]()
    lines.push((await iter.next()).value)
    lines.push((await iter.next()).value)
    lines.push((await iter.next()).value)

    fake.exit(0)
    await handle.exited

    const recording = recorder.getRecording()
    expect(recording[0]).toEqual({ type: 'meta', ts: 0, format: 1 })

    const stdoutEntries = recording.filter(e => e.type === 'stdout')
    expect(stdoutEntries).toHaveLength(3)
    expect(stdoutEntries[0].data).toBe(JSON.stringify(INIT_EVENT))
    expect(stdoutEntries[1].data).toBe(JSON.stringify(TEXT_ASSISTANT))
    expect(stdoutEntries[2].data).toBe(JSON.stringify(RESULT_SUCCESS))

    const exitEntries = recording.filter(e => e.type === 'exit')
    expect(exitEntries).toHaveLength(1)
    expect(exitEntries[0].code).toBe(0)
  })

  it('records stdin writes', async () => {
    const fakeAdapter = new FakeAdapter()
    const recorder = new CassetteRecorder(fakeAdapter)

    const handle = await recorder.spawn({ prompt: 'hello' })
    handle.write('follow-up message\n')

    const recording = recorder.getRecording()
    const stdinEntries = recording.filter(e => e.type === 'stdin')
    expect(stdinEntries).toHaveLength(1)
    expect(stdinEntries[0].data).toBe('follow-up message\n')
  })

  it('passes through to the inner adapter', async () => {
    const fakeAdapter = new FakeAdapter()
    const recorder = new CassetteRecorder(fakeAdapter)

    const handle = await recorder.spawn({ prompt: 'hello' })

    // Inner adapter received the spawn
    expect(fakeAdapter.spawned).toHaveLength(1)

    // Write passes through
    handle.write('test')
    expect(fakeAdapter.latest.stdinWrites).toEqual(['test'])

    // Signal passes through
    handle.signal('SIGTERM')
    expect(fakeAdapter.latest.signals).toEqual(['SIGTERM'])
  })

  it('tracks multiple recordings', async () => {
    const fakeAdapter = new FakeAdapter()
    const recorder = new CassetteRecorder(fakeAdapter)

    await recorder.spawn({ prompt: 'first' })
    await recorder.spawn({ prompt: 'second' })

    expect(recorder.recordingCount).toBe(2)
    expect(recorder.getRecording(0)).toBeDefined()
    expect(recorder.getRecording(1)).toBeDefined()
    // Default is most recent
    expect(recorder.getRecording()).toBe(recorder.getRecording(1))
  })
})

// ---- CassetteAdapter (replay) ----

describe('CassetteAdapter', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('throws on empty cassette', () => {
    expect(() => new CassetteAdapter([])).toThrow('Cassette is empty')
  })

  it('replays stdout lines in order', async () => {
    const adapter = new CassetteAdapter(simpleRecording())
    const handle = await adapter.spawn({ prompt: 'test' })

    const lines: string[] = []
    const collect = (async () => {
      for await (const line of handle.stdout) {
        lines.push(line)
      }
    })()

    // Advance past all delays
    await vi.advanceTimersByTimeAsync(300)
    await collect

    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0]).type).toBe('system')
    expect(JSON.parse(lines[1]).type).toBe('assistant')
    expect(JSON.parse(lines[2]).type).toBe('result')
  })

  it('resolves exited with recorded code', async () => {
    const adapter = new CassetteAdapter(simpleRecording())
    const handle = await adapter.spawn({ prompt: 'test' })

    // Drain stdout
    const drain = (async () => {
      for await (const _ of handle.stdout) { /* consume */ }
    })()

    await vi.advanceTimersByTimeAsync(300)
    await drain

    const exit = await handle.exited
    expect(exit.code).toBe(0)
    expect(handle.alive).toBe(false)
  })

  it('preserves inter-event timing', async () => {
    const adapter = new CassetteAdapter(simpleRecording())
    const handle = await adapter.spawn({ prompt: 'test' })

    const iter = handle.stdout[Symbol.asyncIterator]()
    const timestamps: number[] = []

    // First line at ts=10
    await vi.advanceTimersByTimeAsync(10)
    const r1 = await iter.next()
    expect(r1.done).toBe(false)
    timestamps.push(Date.now())

    // Second line at ts=50 (40ms after first)
    await vi.advanceTimersByTimeAsync(40)
    const r2 = await iter.next()
    expect(r2.done).toBe(false)

    // Third line at ts=100 (50ms after second)
    await vi.advanceTimersByTimeAsync(50)
    const r3 = await iter.next()
    expect(r3.done).toBe(false)

    expect(JSON.parse(r1.value).type).toBe('system')
    expect(JSON.parse(r2.value).type).toBe('assistant')
    expect(JSON.parse(r3.value).type).toBe('result')
  })

  it('pauses at stdin markers until write() is called', async () => {
    const adapter = new CassetteAdapter(multiTurnRecording())
    const handle = await adapter.spawn({ prompt: 'test' })

    const lines: string[] = []
    const collect = (async () => {
      for await (const line of handle.stdout) {
        lines.push(line)
      }
    })()

    // Advance past first turn (0-100ms)
    await vi.advanceTimersByTimeAsync(150)
    expect(lines).toHaveLength(3)

    // Playback is now paused at the stdin marker — even advancing time won't help
    await vi.advanceTimersByTimeAsync(10000)
    expect(lines).toHaveLength(3) // Still 3

    // Send follow-up — unlocks playback
    handle.write('follow-up')
    expect(adapter.stdinWrites).toEqual(['follow-up'])

    // Advance past second turn (80ms + 70ms after stdin)
    await vi.advanceTimersByTimeAsync(200)
    await vi.advanceTimersByTimeAsync(200)
    expect(lines).toHaveLength(5) // 3 + 2 more

    // Advance to exit
    await vi.advanceTimersByTimeAsync(3000)
    await collect

    expect(lines).toHaveLength(5)
  })

  it('skips user think-time at stdin markers', async () => {
    // The recording has a 4900ms gap between result (ts=100) and stdin (ts=5000).
    // Replay should NOT wait 4900ms — it should pause immediately at the stdin
    // marker and resume when write() is called. Only the 80ms from stdin (ts=5000)
    // to next stdout (ts=5080) should be a real delay.
    const adapter = new CassetteAdapter(multiTurnRecording())
    const handle = await adapter.spawn({ prompt: 'test' })

    const lines: string[] = []
    const collect = (async () => {
      for await (const line of handle.stdout) {
        lines.push(line)
      }
    })()

    // First turn
    await vi.advanceTimersByTimeAsync(150)
    expect(lines).toHaveLength(3)

    // Immediately write (no need to wait 4900ms)
    handle.write('follow-up')

    // Only need to wait ~80ms for the next stdout (CLI processing time)
    await vi.advanceTimersByTimeAsync(100)
    expect(lines.length).toBeGreaterThanOrEqual(4)

    // Clean up
    await vi.advanceTimersByTimeAsync(5000)
    await collect
  })

  it('captures signals for assertions', async () => {
    const adapter = new CassetteAdapter(simpleRecording())
    const handle = await adapter.spawn({ prompt: 'test' })

    handle.signal('SIGINT')
    handle.signal('SIGTERM')

    expect(adapter.signals).toEqual(['SIGINT', 'SIGTERM'])

    // Clean up
    const drain = (async () => {
      for await (const _ of handle.stdout) { /* consume */ }
    })()
    await vi.advanceTimersByTimeAsync(300)
    await drain
  })
})

// ---- Round-trip: Record → Serialize → Replay → Same events ----

describe('cassette round-trip through SessionManager', () => {
  it('recording replays the same harness events', async () => {
    // Step 1: Record a session using FakeProcess
    const fakeAdapter = new FakeAdapter()
    const recorder = new CassetteRecorder(fakeAdapter)
    const sm1 = new SessionManager(recorder)

    await sm1.start('s1', { prompt: 'hello' })
    const fake = fakeAdapter.latest

    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))

    // Let events pipe through
    await new Promise(resolve => setTimeout(resolve, 50))

    fake.exit(0)
    await new Promise(resolve => setTimeout(resolve, 50))

    const recordedEvents = sm1.getLog('s1')!.all()

    // Step 2: Serialize and parse the recording
    const recording = recorder.getRecording()
    const serialized = serializeCassette(recording)
    const parsed = parseCassette(serialized)

    // Step 3: Replay through a fresh SessionManager
    const replayAdapter = new CassetteAdapter(parsed)
    const sm2 = new SessionManager(replayAdapter)

    await sm2.start('s2', { prompt: 'hello' })

    // Let replay events pipe through
    await new Promise(resolve => setTimeout(resolve, 200))

    const replayedEvents = sm2.getLog('s2')!.all()

    // Step 4: Compare — event types and content should match
    // (Excluding run:start/input:sent which are emitted by SessionManager itself,
    // and run:end which depends on exit timing)
    const normalize = (events: { type: string; data: unknown }[]) =>
      events
        .filter(e => !['run:start', 'input:sent', 'run:end'].includes(e.type))
        .map(e => ({ type: e.type, data: e.data }))

    const original = normalize(recordedEvents)
    const replayed = normalize(replayedEvents)

    expect(replayed).toEqual(original)
  })
})
