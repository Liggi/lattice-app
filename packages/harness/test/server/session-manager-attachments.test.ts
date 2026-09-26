import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionManager } from '../../src/server/session-manager.js'
import { FakeAdapter } from '../helpers/fake-process.js'
import { INIT_EVENT, RESULT_SUCCESS } from '../helpers/fixtures.js'
import type { InputSentData } from '../../src/protocol/events.js'

let adapter: FakeAdapter
let manager: SessionManager

const IMAGE = {
  type: 'image' as const,
  source: { type: 'base64' as const, media_type: 'image/png', data: 'aW1hZ2U=' },
}
const PDF = {
  type: 'document' as const,
  source: { type: 'base64' as const, media_type: 'application/pdf', data: 'JVBERi0=' },
}

function inputEvents(sessionId: string) {
  return manager
    .getLog(sessionId)!
    .all()
    .filter((e) => e.type === 'input:sent')
    .map((e) => e.data as InputSentData)
}

/** Drive a session from start to idle so the next send takes the stdin path. */
async function reachIdle(sessionId: string) {
  const fake = adapter.latest
  fake.emitLine(JSON.stringify(INIT_EVENT))
  await vi.advanceTimersByTimeAsync(0)
  fake.emitLine(JSON.stringify(RESULT_SUCCESS))
  await vi.advanceTimersByTimeAsync(0)
  expect(manager.getStatus(sessionId)).toBe('idle')
}

beforeEach(() => {
  vi.useFakeTimers()
  adapter = new FakeAdapter()
  manager = new SessionManager(adapter)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionManager — attachments on input:sent', () => {
  it('copies attachments from the send extra bag onto the event', async () => {
    await manager.start('s1', { prompt: 'hello' })
    await reachIdle('s1')

    await manager.send('s1', 'what is this?', { attachments: [IMAGE] })

    const events = inputEvents('s1')
    expect(events.at(-1)).toEqual({ text: 'what is this?', blocks: [IMAGE] })
  })

  it('still forwards the extra bag to the process write', async () => {
    await manager.start('s1', { prompt: 'hello' })
    await reachIdle('s1')

    await manager.send('s1', 'what is this?', { attachments: [IMAGE] })

    expect(adapter.latest.stdinExtras.at(-1)).toEqual({ attachments: [IMAGE] })
  })

  it('omits blocks entirely for a text-only send', async () => {
    await manager.start('s1', { prompt: 'hello' })
    await reachIdle('s1')

    await manager.send('s1', 'plain follow-up')

    expect(inputEvents('s1').at(-1)).toEqual({ text: 'plain follow-up' })
  })

  it('carries attachments on the first turn via SpawnConfig.extra', async () => {
    await manager.start('s1', { prompt: 'review this', extra: { attachments: [IMAGE, PDF] } })

    expect(inputEvents('s1')[0]).toEqual({ text: 'review this', blocks: [IMAGE, PDF] })
  })

  it('emits input:sent for an attachment-only first turn (empty prompt)', async () => {
    await manager.start('s1', { prompt: '', extra: { attachments: [IMAGE] } })

    expect(inputEvents('s1')).toEqual([{ text: '', blocks: [IMAGE] }])
  })

  it('still emits nothing for an empty prompt with no attachments', async () => {
    await manager.start('s1', { prompt: '' })

    expect(inputEvents('s1')).toHaveLength(0)
  })

  it('drops malformed blocks rather than logging them', async () => {
    await manager.start('s1', {
      prompt: 'hi',
      extra: { attachments: [{ type: 'video', src: 'nope' }, IMAGE, { type: 'image' }] },
    })

    expect(inputEvents('s1')[0]).toEqual({ text: 'hi', blocks: [IMAGE] })
  })

  it('keeps attachments out of run:start so base64 is not persisted per run', async () => {
    await manager.start('s1', { prompt: 'hi', extra: { provider: 'claude', attachments: [IMAGE] } })

    const runStart = manager.getLog('s1')!.all().find((e) => e.type === 'run:start')!
    const { config } = runStart.data as { config: { extra?: Record<string, unknown> } }
    expect(config.extra).toEqual({ provider: 'claude' })
  })

  it('does not replay a previous turn attachment on a later attachment-less respawn', async () => {
    // First turn carries an image, then the process exits.
    await manager.start('s1', { prompt: 'look', extra: { provider: 'claude', attachments: [IMAGE] } })
    await reachIdle('s1')
    adapter.latest.exit(0)
    await vi.advanceTimersByTimeAsync(0)

    // Follow-up with no attachments respawns from lastConfig.
    await manager.send('s1', 'plain follow-up')

    expect(adapter.spawned).toHaveLength(2)
    expect(adapter.spawned[1]).toBeDefined()
    expect(inputEvents('s1').at(-1)).toEqual({ text: 'plain follow-up' })
  })

  it('carries attachments through a respawn when the follow-up has them', async () => {
    await manager.start('s1', { prompt: 'first', extra: { provider: 'claude' } })
    await reachIdle('s1')
    adapter.latest.exit(0)
    await vi.advanceTimersByTimeAsync(0)

    await manager.send('s1', 'second', { attachments: [PDF] })

    expect(inputEvents('s1').at(-1)).toEqual({ text: 'second', blocks: [PDF] })
  })
})
