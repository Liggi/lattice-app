import { describe, expect, it } from 'vitest'
import { SessionManager } from '../../src/server/session-manager.js'
import type { ProcessAdapter, ProcessHandle, SpawnConfig } from '../../src/server/process-adapter.js'
import type { InputSentData } from '../../src/protocol/events.js'
import { FakeAdapter, FakeProcess } from '../helpers/fake-process.js'
import { INIT_EVENT, RESULT_SUCCESS } from '../helpers/fixtures.js'

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('SessionManager.compact', () => {
  it('uses the command fallback for an idle live provider and marks it as non-user input', async () => {
    const adapter = new FakeAdapter()
    const manager = new SessionManager(adapter)
    await manager.start('s1', { prompt: 'hello' })
    const process = adapter.latest
    process.emitLine(JSON.stringify(INIT_EVENT))
    process.emitLine(JSON.stringify(RESULT_SUCCESS))
    await settle()

    await manager.compact('s1')

    expect(process.stdinWrites).toEqual(['/compact\n'])
    expect(process.stdinExtras).toEqual([{
      internalCommand: 'compact',
      inputSource: 'command',
    }])
    const compactInput = manager.getLog('s1')!.all().at(-1)
    expect(compactInput?.type).toBe('input:sent')
    expect(compactInput?.data as InputSentData).toEqual({
      text: '/compact',
      source: 'command',
    })
    expect(manager.getStatus('s1')).toBe('streaming')
  })

  it('prefers a provider-native compact method and rejects compaction during a turn', async () => {
    class NativeCompactProcess extends FakeProcess {
      compactCalls = 0

      async compact(): Promise<void> {
        this.compactCalls += 1
      }
    }

    const process = new NativeCompactProcess()
    const adapter: ProcessAdapter = {
      async spawn(_config: SpawnConfig): Promise<ProcessHandle> {
        return process
      },
    }
    const manager = new SessionManager(adapter)
    await manager.start('s1', { prompt: 'hello' })
    process.emitLine(JSON.stringify(INIT_EVENT))
    await settle()

    await expect(manager.compact('s1')).rejects.toThrow('Cannot compact while session is streaming')

    process.emitLine(JSON.stringify(RESULT_SUCCESS))
    await settle()
    await manager.compact('s1')

    expect(process.compactCalls).toBe(1)
    expect(process.stdinWrites).toHaveLength(0)
  })
})
