/**
 * Regression suite — 14 known Lattice/Analyst failure modes.
 *
 * Each test reproduces the exact scenario that caused a real bug and
 * verifies that harness's architecture structurally prevents it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionManager } from '../../src/server/session-manager.js'
import { FakeAdapter, FakeProcess } from '../helpers/fake-process.js'
import { MemoryStorage } from '../helpers/memory-storage.js'
import { INIT_EVENT, TEXT_ASSISTANT, RESULT_SUCCESS, COMPACT_BOUNDARY } from '../helpers/fixtures.js'

let adapter: FakeAdapter
let manager: SessionManager

beforeEach(() => {
  vi.useFakeTimers()
  adapter = new FakeAdapter()
  manager = new SessionManager(adapter)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Regression suite', () => {
  it('#1 — no orphaned process on resume: start() rejects if process is alive', async () => {
    // Bug: Registry tracked old run, daemon served it back, creating an orphan.
    // Prevention: start() checks process?.alive and throws.
    await manager.start('s1', { prompt: 'first' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    // Attempt to start a new run while process is alive
    await expect(manager.start('s1', { prompt: 'second' })).rejects.toThrow(
      'Session already has an active process',
    )

    // Only one process was spawned
    expect(adapter.spawned).toHaveLength(1)
  })

  it('#2 — no synthetic ID confusion: stop uses process handle, not ID lookup', async () => {
    // Bug: Two ID systems (registry IDs vs DB IDs) desynced, breaking stop.
    // Prevention: stop() uses the process handle directly. Only 2 IDs (sessionId, runId).
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    await manager.stop('s1')
    expect(fake.signals).toContain('SIGINT')
    expect(manager.getStatus('s1')).toBe('stopping')
  })

  it('#3 — zombie SSE connections have zero state impact', async () => {
    // Bug: Dead SSE connections affected session state in Lattice.
    // Prevention: SSE connections are read-only subscribers to the log.
    // Subscribing/unsubscribing has no effect on session state.
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    const log = manager.getLog('s1')!

    // Simulate SSE connections subscribing and dying
    const unsub1 = log.subscribe(() => {})
    const unsub2 = log.subscribe(() => {})
    expect(log.subscriberCount).toBe(2)

    // "Zombie" disconnects
    unsub1()
    unsub2()
    expect(log.subscriberCount).toBe(0)

    // Session state is completely unaffected
    expect(manager.getStatus('s1')).toBe('streaming')
    expect(fake.alive).toBe(true)
  })

  it('#4 — no RESET race: status is derived, never set', async () => {
    // Bug: Optimistic status raced with authoritative status during RESET.
    // Prevention: status is a pure function of events. No "set" to race with.
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await vi.advanceTimersByTimeAsync(0)

    // Status at any point is deterministic from events
    const events = manager.getLog('s1')!.all()
    const status1 = manager.getStatus('s1')
    const status2 = manager.getStatus('s1')
    expect(status1).toBe(status2)
    expect(status1).toBe('streaming')

    // Even after adding more events, derivation is immediate and consistent
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.getStatus('s1')).toBe('idle')
  })

  it('#5 — harness doesnt manage messages: events are append-only', async () => {
    // Bug: Optimistic message wiped by hydration effect clearing state.
    // Prevention: Harness doesn't manage messages. Apps handle optimistic
    // display in their own layer. Events are append-only, never cleared.
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await vi.advanceTimersByTimeAsync(0)

    const eventsBefore = manager.getLog('s1')!.all().length

    // More events arrive — they are appended, never cleared
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await vi.advanceTimersByTimeAsync(0)

    const eventsAfter = manager.getLog('s1')!.all().length
    expect(eventsAfter).toBe(eventsBefore + 1)
  })

  it('#6 — stop has guaranteed escalation: SIGINT → SIGTERM → SIGKILL', async () => {
    // Bug: Graceful stop failure silently swallowed, process hung forever.
    // Prevention: Escalating kill with guaranteed SIGKILL.
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    await manager.stop('s1')
    expect(fake.signals).toEqual(['SIGINT'])

    // Process ignores SIGINT
    await vi.advanceTimersByTimeAsync(3000)
    expect(fake.signals).toEqual(['SIGINT', 'SIGTERM'])

    // Process ignores SIGTERM
    await vi.advanceTimersByTimeAsync(2000)
    expect(fake.signals).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL'])
  })

  it('#7 — no stale status from cache: status derived fresh every time', async () => {
    // Bug: 30-second staleTime cache caused stale status across navigation.
    // Prevention: Status derived from events on every call. No cache.
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    expect(manager.getStatus('s1')).toBe('streaming')

    // Session ends
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)
    fake.exit(0)
    await vi.advanceTimersByTimeAsync(0)

    // Status immediately reflects reality — no stale cache
    expect(manager.getStatus('s1')).toBe('idle')
  })

  it('#8 — one code path through ProcessAdapter: no provider-specific bugs', async () => {
    // Bug: Codex-specific code path missing error handling.
    // Prevention: One code path through ProcessAdapter. Provider differences
    // are isolated in the adapter, not spread across session management.
    const adapter2 = new FakeAdapter()
    const manager2 = new SessionManager(adapter2)

    // Both "providers" go through the exact same SessionManager logic
    await manager.start('s1', { prompt: 'hello' })
    await manager2.start('s1', { prompt: 'hello' })

    adapter.latest.emitLine(JSON.stringify(INIT_EVENT))
    adapter2.latest.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    // Both derive status identically
    expect(manager.getStatus('s1')).toBe('streaming')
    expect(manager2.getStatus('s1')).toBe('streaming')
  })

  it('#9 — no keep-alive desync: input:sent event keeps status streaming', async () => {
    // Bug: Registry not updated after stdin write, causing desync.
    // Prevention: send() appends input:sent. deriveStatus sees it → streaming.
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)

    // Status is idle after turn ends, but process is still alive
    expect(manager.getStatus('s1')).toBe('idle')
    expect(fake.alive).toBe(true)

    // Send follow-up while process alive — writes to stdin
    await manager.send('s1', 'follow up')
    // input:sent event transitions status to streaming — no manual registry update needed
    expect(manager.getStatus('s1')).toBe('streaming')
    expect(fake.stdinWrites).toEqual(['follow up\n'])
  })

  it('#10 — no wrong-conversation dispatch: send takes a sessionId directly', async () => {
    // Bug: Wrong ID passed during resume registration.
    // Prevention: send() takes sessionId. Session already exists in the map.
    await manager.start('s1', { prompt: 'hello' })
    await manager.start('s2', { prompt: 'world' })

    const fake1 = adapter.spawned[0]
    const fake2 = adapter.spawned[1]
    fake1.emitLine(JSON.stringify(INIT_EVENT))
    fake2.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    // Send to s1 — only s1's process gets the input
    await manager.send('s1', 'message for s1')
    expect(fake1.stdinWrites).toEqual(['message for s1\n'])
    expect(fake2.stdinWrites).toEqual([])

    // Send to s2 — only s2's process gets the input
    await manager.send('s2', 'message for s2')
    expect(fake2.stdinWrites).toEqual(['message for s2\n'])
  })

  it('#11 — single SSE connection, no polling: one subscriber per client', async () => {
    // Bug: Permission polling stacked requests, exhausting connection pool.
    // Prevention: Harness uses a single SSE connection per session. No polling.
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    const log = manager.getLog('s1')!

    // Simulate what a single SSE client does: one subscribe
    const events: string[] = []
    const unsub = log.subscribe((e) => events.push(e.type))

    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await vi.advanceTimersByTimeAsync(0)

    // One subscriber, one event delivery
    expect(log.subscriberCount).toBe(1)
    expect(events).toEqual(['content'])

    unsub()
    expect(log.subscriberCount).toBe(0)
  })

  it('#12 — clean restart on server loss: no synthetic recovery IDs', async () => {
    // Bug: In-memory registry cleared on deploy, recovered with wrong IDs.
    // Prevention: On loss, client gets reset and rehydrates from app persistence.
    // No synthetic recovery. Clean restart.
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await vi.advanceTimersByTimeAsync(0)

    // Simulate server restart: destroy all sessions
    manager.destroy('s1')
    expect(manager.hasSession('s1')).toBe(false)
    expect(manager.getLog('s1')).toBeNull()

    // New session starts clean — no recovery with wrong IDs
    await manager.start('s1', { prompt: 'hello again' })
    const log = manager.getLog('s1')!
    expect(log.all()).toHaveLength(2) // run:start + input:sent, no stale events
    expect(log.all()[0].type).toBe('run:start')
    expect(log.all()[1].type).toBe('input:sent')
  })

  it('#13 — one SSE endpoint per session: no streamingId to resolve', async () => {
    // Bug: Frontend didn't know which streamingId to connect to for inject.
    // Prevention: One event stream per session. No streamingId concept.
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    // The log is the only thing you need to stream events
    const log = manager.getLog('s1')!
    expect(log).toBeTruthy()

    // send() just writes to stdin, no need to resolve a streaming connection
    await manager.send('s1', 'inject')
    expect(fake.stdinWrites).toEqual(['inject\n'])
  })

  it('#15 — start() kills idle keep-alive process before respawning', async () => {
    // Bug: Daemon keep-alive leaves process alive after turn. start() throws
    // "Session already has an active process" even though session is idle.
    // Prevention: start() detects idle status + alive process and kills it first.
    await manager.start('s1', { prompt: 'first' })
    const fake1 = adapter.latest
    fake1.emitLine(JSON.stringify(INIT_EVENT))
    fake1.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake1.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)

    // Process is alive (keep-alive), status is idle
    expect(manager.getStatus('s1')).toBe('idle')
    expect(fake1.alive).toBe(true)

    // start() should kill the old process and spawn a new one — not throw
    const startPromise = manager.start('s1', { prompt: 'second' })

    // The old process receives SIGTERM and exits
    expect(fake1.signals).toContain('SIGTERM')
    fake1.exit(0)
    await vi.advanceTimersByTimeAsync(0)

    await expect(startPromise).resolves.toBeDefined()

    // New process was spawned
    expect(adapter.spawned).toHaveLength(2)
    const fake2 = adapter.latest
    expect(fake2).not.toBe(fake1)
  })

  it('#15b — a replaced process that exits late does not end the new run', async () => {
    // Bug (2026-09-29): the retired keep-alive outlived start()'s 5s wait, so
    // its exit (code 143) landed inside the new run. The run:end read as the
    // new turn failing, and nulling session.process made the next send spawn
    // again and kill the live process — a loop on every message.
    await manager.start('s1', { prompt: 'first' })
    const fake1 = adapter.latest
    fake1.emitLine(JSON.stringify(INIT_EVENT))
    fake1.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)

    const startPromise = manager.start('s1', { prompt: 'second' })
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise
    const fake2 = adapter.latest
    fake2.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    fake1.exit(143)
    await vi.advanceTimersByTimeAsync(0)

    const events = manager.getLog('s1')!.all()
    expect(events.filter(e => e.type === 'run:end')).toHaveLength(0)
    expect(manager.getStatus('s1')).toBe('streaming')

    fake2.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)
    await manager.send('s1', 'third')
    expect(adapter.spawned).toHaveLength(2)
    expect(fake2.stdinWrites).toEqual(['third\n'])
  })

  it('#15c — a second start during the first one\'s spawn is refused', async () => {
    // Bug (2026-09-29): two starts 4s apart both found no process and each
    // spawned a CLI resuming the same session.
    const first = manager.start('s1', { prompt: 'first' })
    await expect(manager.start('s1', { prompt: 'second' })).rejects.toThrow('Session is already starting')
    await first
    expect(adapter.spawned).toHaveLength(1)
  })

  it('#16 — /compact transitions to idle so next message can be sent', async () => {
    // Bug: normalizeClaude dropped compact_boundary events, so deriveStatus
    // stayed "streaming" after /compact. start() threw "Session already has
    // an active process" even though the turn was done.
    // Prevention: compact_boundary is now normalized to turn:end.
    await manager.start('s1', { prompt: '/compact' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    await vi.advanceTimersByTimeAsync(0)

    // Compact emits status events (skipped) then compact_boundary (now turn:end)
    fake.emitLine(JSON.stringify({
      type: 'system', subtype: 'status', status: 'compacting', session_id: 'abc-123',
    }))
    fake.emitLine(JSON.stringify({
      type: 'system', subtype: 'status', status: null, session_id: 'abc-123',
    }))
    fake.emitLine(JSON.stringify(COMPACT_BOUNDARY))
    await vi.advanceTimersByTimeAsync(0)

    // Session is now idle — the compact_boundary produced a turn:end
    expect(manager.getStatus('s1')).toBe('idle')

    // Process is still alive (keep-alive) — start() should kill it and respawn
    expect(fake.alive).toBe(true)
    const startPromise = manager.start('s1', { prompt: 'follow-up' })
    fake.exit(0)
    await vi.advanceTimersByTimeAsync(5000)
    await expect(startPromise).resolves.toBeDefined()
    expect(adapter.spawned).toHaveLength(2)
  })

  it('#14 — one code path for all modes: turn:end always produces idle', async () => {
    // Bug: turn-idle event only wired for daemon mode, missing in direct mode.
    // Prevention: One pipeEvents path. turn:end → deriveStatus → idle. Always.
    await manager.start('s1', { prompt: 'hello' })
    const fake = adapter.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)

    // turn:end (from result event) always produces idle regardless of mode
    expect(manager.getStatus('s1')).toBe('idle')

    // Verify the event is in the log
    const events = manager.getLog('s1')!.all()
    expect(events.some((e) => e.type === 'turn:end')).toBe(true)
  })

  it('#17 — recovered session after restart derives idle, not stuck streaming', async () => {
    // Bug: After deploy, harness recovered session from storage. Last stored
    // events were content (no turn:end/run:end — server died mid-stream).
    // SSE replayed those events to the client, which derived status=streaming
    // and showed a thinking indicator. But no process existed, so no live
    // events arrived. Session stuck forever with a spinning indicator.
    //
    // Fix: recoverFromStorage injects a run:end event for interrupted sessions
    // so they cleanly derive as idle.

    const storage = new MemoryStorage()
    const adapter1 = new FakeAdapter()
    const manager1 = new SessionManager(adapter1, { storage })

    // Start a session and stream some content
    await manager1.start('s1', { prompt: 'hello', cwd: '/project' })
    const fake = adapter1.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await vi.advanceTimersByTimeAsync(0)

    // Session is actively streaming — content events, no turn:end
    expect(manager1.getStatus('s1')).toBe('streaming')

    // Verify events are in storage (they were persisted during streaming)
    expect(storage.count('s1')).toBeGreaterThan(0)

    // === SERVER CRASHES / DEPLOYS HERE ===
    // The process dies, the SessionManager is garbage collected.
    // No turn:end or run:end was ever written.

    // New server starts with a fresh SessionManager, same storage
    const adapter2 = new FakeAdapter()
    const manager2 = new SessionManager(adapter2, { storage })

    // SSE handler triggers recovery
    const log = manager2.recoverFromStorage('s1')
    expect(log).not.toBeNull()

    // THE FIX: status must be idle, not streaming
    expect(manager2.getStatus('s1')).toBe('idle')

    // A run:end event was injected with server_restart reason and is
    // tagged as inferred so reducers can tell it apart from a real
    // provider-emitted run:end.
    const allEvents = log!.since(0)
    const runEnd = allEvents.find(e => e.type === 'run:end')
    expect(runEnd).toBeDefined()
    expect(runEnd!.data).toEqual({ reason: 'server_restart', code: null })
    expect(runEnd!.meta).toEqual({ inferred: true, source: 'recovery' })
  })

  it('#17b — recovered session preserves resumeId for follow-up send', async () => {
    // The recovery must extract resumeId from stored run:ready events
    // so that send() can respawn with --resume.

    const storage = new MemoryStorage()
    const adapter1 = new FakeAdapter()
    const manager1 = new SessionManager(adapter1, { storage })

    await manager1.start('s1', { prompt: 'hello', cwd: '/project' })
    const fake = adapter1.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await vi.advanceTimersByTimeAsync(0)

    // === SERVER RESTARTS ===
    const adapter2 = new FakeAdapter()
    const manager2 = new SessionManager(adapter2, { storage })
    manager2.recoverFromStorage('s1')

    // Session is idle, resumeId was recovered from run:ready
    expect(manager2.getStatus('s1')).toBe('idle')
    const diag = manager2.inspect('s1')!
    expect(diag.resumeId).toBe('abc-123') // from INIT_EVENT fixture
  })

  it('#17c — recovered idle session is not modified', async () => {
    // If the session was already idle when the server died (turn completed
    // cleanly), recovery should NOT inject an extra run:end.

    const storage = new MemoryStorage()
    const adapter1 = new FakeAdapter()
    const manager1 = new SessionManager(adapter1, { storage })

    await manager1.start('s1', { prompt: 'hello' })
    const fake = adapter1.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)
    fake.exit(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(manager1.getStatus('s1')).toBe('idle')
    const countBefore = storage.count('s1')

    // === SERVER RESTARTS ===
    const adapter2 = new FakeAdapter()
    const manager2 = new SessionManager(adapter2, { storage })
    manager2.recoverFromStorage('s1')

    // No extra events injected
    expect(storage.count('s1')).toBe(countBefore)
    expect(manager2.getStatus('s1')).toBe('idle')
  })

  it('#17e — a process the previous server left running is taken over mid-turn', async () => {
    // The process host outlived the server: the new server adopts the live
    // process, and the turn carries on in the same run with no run:end.
    const storage = new MemoryStorage()
    const adapter1 = new FakeAdapter()
    const manager1 = new SessionManager(adapter1, { storage })
    await manager1.start('s1', { prompt: 'hello', cwd: '/project', args: ['--permission-mode=acceptEdits'] })
    adapter1.latest.emitLine(JSON.stringify(INIT_EVENT))
    adapter1.latest.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await vi.advanceTimersByTimeAsync(0)
    const runId = storage.read('s1').at(-1)!.runId

    // === SERVER RESTARTS; the process lives on ===
    const manager2 = new SessionManager(new FakeAdapter(), { storage })
    const live = new FakeProcess()
    const taken = manager2.adopt('s1', live)
    expect(taken).toMatchObject({ runId, lastConfig: { args: ['--permission-mode=acceptEdits'] } })
    expect(manager2.getStatus('s1')).toBe('streaming')

    live.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)
    expect(manager2.getStatus('s1')).toBe('idle')
    const events = storage.read('s1')
    expect(events.some((e) => e.type === 'run:end')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'turn:end', runId })
    expect(manager2.inspect('s1')!.processAlive).toBe(true)

    // Its exit ends the run as any other would.
    live.exit(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(storage.read('s1').at(-1)).toMatchObject({ type: 'run:end', runId, data: { reason: 'completed' } })
  })

  it('#17f — a session whose run already ended is not taken over', async () => {
    const storage = new MemoryStorage()
    const adapter1 = new FakeAdapter()
    const manager1 = new SessionManager(adapter1, { storage })
    await manager1.start('s1', { prompt: 'hello' })
    adapter1.latest.emitLine(JSON.stringify(INIT_EVENT))
    adapter1.latest.exit(1)
    await vi.advanceTimersByTimeAsync(0)

    const manager2 = new SessionManager(new FakeAdapter(), { storage })
    expect(manager2.adopt('s1', new FakeProcess())).toBeNull()
    expect(manager2.hasSession('s1')).toBe(false)
  })

  it('#17d — recoverFromStorage finds run:ready buried beyond the tail window', async () => {
    // Bug: recoverFromStorage reads only the last 50 events to derive resumeId.
    // A long single turn (many content blocks, tool uses, thinking, etc.) can
    // bury run:ready beyond that window. Recovery then sets resumeId = null,
    // and any subsequent respawn loses provider session continuity.
    //
    // Fix (tactical 6.1): EventStorageAdapter exposes findLatestRunReady(),
    // which queries by (session_id, type, seq DESC) and returns the most
    // recent run:ready regardless of how deep in history it sits.

    const storage = new MemoryStorage()
    const adapter1 = new FakeAdapter()
    const manager1 = new SessionManager(adapter1, { storage })

    await manager1.start('s1', { prompt: 'hello', cwd: '/project' })
    const fake = adapter1.latest

    // run:ready arrives early in the turn (seq ~2)
    fake.emitLine(JSON.stringify(INIT_EVENT))

    // Bury run:ready: emit 60 content events on the same turn so the tail
    // window (last 50) no longer contains it.
    for (let i = 0; i < 60; i++) {
      fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    }
    fake.emitLine(JSON.stringify(RESULT_SUCCESS))
    await vi.advanceTimersByTimeAsync(0)

    expect(manager1.getStatus('s1')).toBe('idle')
    expect(storage.count('s1')).toBeGreaterThan(50)

    // === SERVER RESTARTS ===
    const adapter2 = new FakeAdapter()
    const manager2 = new SessionManager(adapter2, { storage })
    manager2.recoverFromStorage('s1')

    // resumeId must be the real provider ID from the buried run:ready,
    // not null (which would mean the next respawn drops --resume).
    const diag = manager2.inspect('s1')!
    expect(diag.resumeId).toBe('abc-123')
  })

  it('#17e — recovery-injected run:end carries meta marking it as inferred', async () => {
    // Bug: recovery synthesizes a run:end event for sessions that died
    // mid-stream, but the event looks identical to a real provider-emitted
    // run:end. Reducers can't distinguish the two — diagnostic surfaces and
    // future invariant checks have no way to tell "this run ended because
    // the server restarted" from "this run ended because the model finished
    // its turn." Tactical 6.2: recovery events carry
    // meta = { inferred: true, source: 'recovery' }.

    const storage = new MemoryStorage()
    const adapter1 = new FakeAdapter()
    const manager1 = new SessionManager(adapter1, { storage })

    await manager1.start('s1', { prompt: 'hello' })
    const fake = adapter1.latest
    fake.emitLine(JSON.stringify(INIT_EVENT))
    fake.emitLine(JSON.stringify(TEXT_ASSISTANT))
    await vi.advanceTimersByTimeAsync(0)

    // Mid-stream: server crashes, no real run:end is ever emitted.
    expect(manager1.getStatus('s1')).toBe('streaming')

    // === SERVER RESTARTS ===
    const adapter2 = new FakeAdapter()
    const manager2 = new SessionManager(adapter2, { storage })
    const log = manager2.recoverFromStorage('s1')!

    const runEnd = log.since(0).find(e => e.type === 'run:end')!
    expect(runEnd.data).toEqual({ reason: 'server_restart', code: null })
    expect(runEnd.meta?.inferred).toBe(true)
    expect(runEnd.meta?.source).toBe('recovery')
  })
})
