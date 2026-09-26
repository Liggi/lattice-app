# Frontend perf telemetry — plan

Passive browser-side telemetry to diagnose real usage perf (especially mobile typing lag) over a session of normal use, rather than synthetic Chrome DevTools traces.

## Motivation

Mobile typing feels laggy. Synthetic idle traces showed ~33% of one core burning in React reconciler + Radix primitives with ~200 MessageChannel posts/s and ~18k JSON.stringify/s from React Query hashKey — but DOM mutations per 2s were near zero, so most of that work is bailing out before commit. None of it clearly explains typing latency.

The honest next step is to measure real usage: use the app for a while, then inspect what blocked the main thread and how long input-to-paint took.

## What to capture

All via native browser APIs, cheap and passive:

1. **Long tasks** — `PerformanceObserver` on `longtask`. Every task >50ms blocking the main thread. Fields: `startTime`, `duration`, `attribution[].name` (script URL if available).
2. **Long animation frames (LoAF)** — `PerformanceObserver` on `long-animation-frame`. Newer API, breaks down render vs script vs layout. Names the longest blocking script via `scripts[].invoker`. Chromium-only for now.
3. **Input latency** — `keydown` / `pointerdown` listener. Record `event.timeStamp → next rAF`. Crude INP proxy; enough to spot "typed a character, next frame was 300ms later."
4. **Rolling 10s counters** — emit one aggregated row every 10s: `{ rafCount, longTaskCount, longTaskTotalMs, inputEventCount, maxInputLatencyMs }`. Keeps a continuous baseline even when nothing "long" fires.

## Budget

- One entry per long event (expect dozens/hour in normal use).
- One row per 10s window.
- A heavy-use hour ≈ a few KB.

## Storage

- In-memory ring buffer (cap e.g. 5,000 entries).
- Flush to `localStorage` every 30s under a fixed key so it survives reloads.
- On overflow, drop oldest.

## Readout

Two options to decide at implementation time:

- **(a) DevTools only** — expose `window.__latticePerf.dump()` / `.reset()`. Simplest. Requires opening DevTools to retrieve.
- **(b) Server endpoint** — small POST endpoint that accepts the buffer; readout via `curl localhost:3001/__perf` or similar. Survives across devices; lets you pull from mobile without plugging in.

Option (b) is more useful for the mobile case specifically — that's the device where the bug lives, and DevTools access is awkward.

## Wiring

- New `src/web/chat/perf-telemetry.ts`. Idempotent `initPerfTelemetry()` export.
- Import once from the app root (likely `src/web/chat/App.tsx` or `main.tsx`).
- Gate on URL flag `?perf=1` or `localStorage.__lattice_perf_enabled = '1'` so it doesn't run for all users by default — pure debugging tool.

## Interpretation notes

When reading the buffer back:

- **Long tasks clustered around keydown events** → typing is genuinely blocked on something. Attribution URL points at the offending script bundle.
- **LoAF rows with `renderDuration` dominant** → React reconciliation. Check what component triggered the commit.
- **LoAF with `styleAndLayoutDuration` dominant** → CSS recalc / layout thrash. Likely Radix or a layout-reading hook.
- **High rolling `rafCount` with no matching commits** → unnecessary animation loop (like ThinkingIndicator's canvas, which was observed running at 60Hz in idle — worth revisiting but not proven to cause lag).
- **Input latency p95 >100ms** → visible to the user. >200ms feels broken.

## Open questions

- Do we want the periodic 10s counters persisted, or only the long-event records? Persisting both gives baseline but doubles storage.
- If we ship server-side readout, gate it behind a dev/debug flag — don't leave an unauthenticated `/__perf` in production.
- Whether to correlate with conversationId / route changes. Probably yes — attach a `context` field to each entry with `location.pathname` at capture time.

## Status

Plan only. Not implemented. Revisit when ready to actually diagnose mobile typing lag with real usage data.
