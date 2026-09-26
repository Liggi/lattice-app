/**
 * BUG: Hydration phase stuck at 'hydrating' when onReplayMeta wins the race
 * against the onConnected backfill IIFE.
 *
 * Reproduction of the state-machine in
 * `@liggi/agent-ui-harness/dist/client/use-session.js` (commit 1b7a525,
 * shipped in v0.1.7). The IIFE in onConnected was changed to skip
 * `maybeFinishHydration()` on its early-return path, on the theory that
 * onReplayMeta would fire after the IIFE finishes. That assumption breaks
 * when SSE events arrive fast enough that the IIFE early-returns *after*
 * onReplayMeta has already fired — then onReplayMeta sees pending=1 and
 * no-ops, and the IIFE's finally{} doesn't re-poke the gate, so the phase
 * never flips.
 *
 * Symptom downstream in Lattice: `latticeStatus = hydrationPhase ===
 * 'hydrating' ? 'idle' : mapStatus(status)` (useHarnessSession.ts:113) →
 * the composer status bar never shows "Working"/"Starting" during a turn,
 * the stop button never appears, and server-side diagnostics show
 * `primaryPhase: 'working'` while the client paints idle.
 *
 * This test mirrors the production state-machine literally: refs for
 * pending and checkpoint, a `setHydrationPhase` callback, and the
 * `maybeFinishHydration()` predicate. The two operations under test are:
 *   - onConnected IIFE: increments pending, awaits 50ms, early-returns,
 *     decrements pending in finally (and currently does NOT call
 *     maybeFinishHydration on the early-return path).
 *   - onReplayMeta:   sets checkpoint=true, then calls
 *     maybeFinishHydration.
 *
 * The race the buggy code permits: replay_meta arrives during the 50ms
 * wait. After the IIFE finishes, the gate stays closed forever.
 */

import { describe, it, expect, vi } from 'vitest';

type Phase = 'hydrating' | 'ready';

/**
 * Mirrors the `onConnected` IIFE + `onReplayMeta` handler from
 * `@liggi/agent-ui-harness/src/client/use-session.ts`, factored out so the
 * timing race can be reproduced without React or SSE.
 */
function makeHydrationMachine() {
  const pendingTasksRef = { current: 0 };
  const checkpointReachedRef = { current: false };
  let phase: Phase = 'hydrating';

  const maybeFinishHydration = () => {
    if (!checkpointReachedRef.current) return;
    if (pendingTasksRef.current > 0) return;
    phase = 'ready';
  };

  /** Production code path (use-session.ts:296–354 in v0.1.7). */
  const onConnectedBackfillIIFE = async (opts: {
    /**
     * Whether SSE events have started arriving by the time the 50ms wait
     * elapses. In production this is `lastSeqRef.current > 0`. When true
     * the IIFE early-returns without setting attemptedBackfill.
     */
    eventsArrivedDuringWait: boolean;
  }) => {
    pendingTasksRef.current += 1;
    let attemptedBackfill = false;
    try {
      await new Promise((r) => setTimeout(r, 50));
      if (opts.eventsArrivedDuringWait) return;
      attemptedBackfill = true;
      // (In production: fetch /history. Side-effect-free for this test.)
    } finally {
      pendingTasksRef.current -= 1;
      if (attemptedBackfill) {
        checkpointReachedRef.current = true;
        maybeFinishHydration();
      }
    }
  };

  /** Production code path (use-session.ts:387–420 in v0.1.7). */
  const onReplayMeta = (meta: { scoped: boolean }) => {
    checkpointReachedRef.current = true;
    if (!meta.scoped) {
      maybeFinishHydration();
      return;
    }
    // Scoped backfill path — irrelevant for this race.
  };

  return {
    getPhase: () => phase,
    onConnectedBackfillIIFE,
    onReplayMeta,
  };
}

describe('agent-ui-harness hydration gate', () => {
  it('BUG: phase stays "hydrating" when replay_meta lands while the onConnected IIFE is still pending and the IIFE then early-returns', async () => {
    vi.useFakeTimers();
    const m = makeHydrationMachine();

    // 1. SSE delivers its first event — onConnected fires, IIFE starts.
    //    `lastSeqRef` is 0 at this moment, so the IIFE entered the
    //    `if (lastSeqRef.current === 0)` branch.
    const iifePromise = m.onConnectedBackfillIIFE({
      eventsArrivedDuringWait: true,
    });

    // 2. While the IIFE is in its 50ms `setTimeout`, the server's
    //    `replay_meta` event arrives. The handler sets the checkpoint and
    //    calls `maybeFinishHydration()` — but pending is 1, so it no-ops.
    m.onReplayMeta({ scoped: false });

    // Sanity: phase has not yet flipped.
    expect(m.getPhase()).toBe('hydrating');

    // 3. The 50ms wait elapses. The IIFE sees events arrived and
    //    early-returns. Its finally{} decrements pending to 0 BUT — because
    //    `attemptedBackfill` is false — does NOT re-call
    //    `maybeFinishHydration()`. The gate is now permanently stuck.
    await vi.advanceTimersByTimeAsync(60);
    await iifePromise;

    // BUG: phase stays 'hydrating'. Production version asserted before
    // commit 1b7a525 was 'ready' here.
    expect(m.getPhase()).toBe('hydrating');

    vi.useRealTimers();
  });

  it('control: when the IIFE finishes BEFORE replay_meta arrives, phase flips correctly', async () => {
    vi.useFakeTimers();
    const m = makeHydrationMachine();

    // 1. IIFE starts, no events arrive in the wait window — runs the
    //    backfill path and sets attemptedBackfill=true.
    const iifePromise = m.onConnectedBackfillIIFE({
      eventsArrivedDuringWait: false,
    });
    await vi.advanceTimersByTimeAsync(60);
    await iifePromise;

    // The backfill path's finally{} sets the checkpoint AND calls
    // maybeFinishHydration(), with pending=0 → flip.
    expect(m.getPhase()).toBe('ready');

    // 2. replay_meta arriving later is harmless.
    m.onReplayMeta({ scoped: false });
    expect(m.getPhase()).toBe('ready');

    vi.useRealTimers();
  });

  it('control: when no IIFE ever runs (lastSeq>0 at onConnected), replay_meta alone is enough', () => {
    const m = makeHydrationMachine();
    // No onConnectedBackfillIIFE call — pending stays at 0. replay_meta
    // sets checkpoint and flips immediately.
    m.onReplayMeta({ scoped: false });
    expect(m.getPhase()).toBe('ready');
  });
});
