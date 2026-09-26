/**
 * Runtime Diagnostics Endpoint — Healthy Case Contract
 *
 * Asserts the contract for `GET /api/diagnostics/conversations/:conversationId`
 * defined in `docs/runtime-diagnostics-and-authority-collapse.md` §1–4 of the
 * design doc (the §1 "Diagnostics endpoint" foundation, consumed later by
 * Move 3 to retire the legacy debug surfaces).
 *
 * This test is the additive-foundation gate for Move 1 of the implementation.
 * It only covers the healthy-case schema contract (§4.1) — it does NOT yet
 * exercise any invariants beyond `runtime_authority_consensus` passing on a
 * stable conversation.
 *
 * Setup:
 *   - seed a conversation
 *   - drive a single full simple-response turn so the harness has run:start →
 *     run:ready → input:sent → content → result → turn:end events recorded
 *   - then call the new diagnostics endpoint and assert the response shape
 *
 * Expected (per §1.3 and §4.1):
 *   - HTTP 200
 *   - schemaVersion === 'lattice.runtime-diagnostics.v1'
 *   - identity.conversationId === conversationId
 *   - identity.provider === 'claude'
 *   - access.mode and access.redaction present
 *   - summary.health === 'healthy'
 *   - summary.highestSeverity === 'pass'
 *   - summary.errorCount === 0
 *   - summary.warnCount === 0
 *   - summary.primaryPhase ∈ {'idle_alive', 'idle_dead'} (post-turn)
 *   - summary.canSubmit === true
 *   - summary.lastSeq is a positive integer
 *   - sources includes a `harness_events` snapshot with facts.phase matching
 *     summary.primaryPhase, facts.sessionKnown=true, facts.hasEventHistory=true
 *   - invariants is an array containing at least `runtime_authority_consensus`
 *     with severity 'pass' and ok=true
 *   - events.window.returned > 0 and events.items[].seq are monotonic
 *   - default response is redacted (no raw payloads on event summaries, no
 *     daemon argv/env, no message text)
 *
 * Endpoint does not exist yet. This test must fail with 404 (or similar) when
 * first run, and pass after Move 1 lands.
 */

import { test, expect } from '@playwright/test';

const BASE_URL = `http://localhost:${process.env.TEST_PORT ?? '4200'}`;

// -- Helpers (mirrors patterns from contracts/26 and 34) --

async function resetServer() {
  await fetch(`${BASE_URL}/api/test/reset`, { method: 'POST' });
}

async function setScenario(scenario: string) {
  await fetch(`${BASE_URL}/api/test/set-scenario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario }),
  });
}

async function seedConversation(): Promise<string> {
  const resp = await fetch(`${BASE_URL}/api/test/seed-conversation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'claude' }),
  });
  const data = (await resp.json()) as { conversationId: string };
  return data.conversationId;
}

// -- Allowed value sets (per §1.3) --

const RUNTIME_PHASES = new Set([
  'absent',
  'starting',
  'working',
  'stopping',
  'idle_alive',
  'idle_dead',
  'error',
]);

const SEVERITIES = new Set(['pass', 'info', 'warn', 'error', 'skipped']);

// ============================================================================
// Healthy-case contract
// ============================================================================

test.describe('GET /api/diagnostics/conversations/:conversationId — healthy case', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('returns a v1 diagnostics report whose harness facts agree with public projection', async ({ page }) => {
    // 1. Drive a full simple turn through the real server + harness so
    //    SqliteEventStorage has a stable run:ready/turn:end history to derive
    //    facts from.
    await setScenario('simple-response');

    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);

    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeVisible({ timeout: 15000 });
    await composer.fill('Hello diagnostics');
    await page.getByTestId('send-button').click();

    // Wait for the turn to complete in the UI...
    await expect(page.getByTestId('assistant-message').first()).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText('Working', { exact: true })).not.toBeVisible({
      timeout: 10000,
    });

    // ...but the UI is not a persistence barrier: the Working pill is
    // hydration-gated (useHarnessSession forces 'idle' while hydrating), so
    // its absence doesn't prove turn:end reached storage — the not-visible
    // check can pass vacuously mid-turn. Settle on the endpoint's own
    // projection before asserting the post-turn contract.
    await expect
      .poll(
        async () => {
          const r = await fetch(
            `${BASE_URL}/api/diagnostics/conversations/${convId}`,
          );
          if (!r.ok) return `http-${r.status}`;
          const b = (await r.json()) as { summary?: { primaryPhase?: string } };
          return b.summary?.primaryPhase;
        },
        { timeout: 10000 },
      )
      .toMatch(/^idle_/);

    // 2. Hit the new diagnostics endpoint.
    const resp = await fetch(
      `${BASE_URL}/api/diagnostics/conversations/${convId}`,
    );

    expect(resp.status).toBe(200);
    const body: any = await resp.json();

    // 3. Top-level envelope (§1.3 ConversationDiagnosticsReport).
    expect(body.schemaVersion).toBe('lattice.runtime-diagnostics.v1');
    expect(typeof body.generatedAtMs).toBe('number');
    expect(body.generatedAtMs).toBeGreaterThan(0);

    expect(body.request).toBeTruthy();
    expect(body.request.conversationId).toBe(convId);
    expect(typeof body.request.requestId).toBe('string');
    expect(body.request.requestId.length).toBeGreaterThan(0);
    expect(typeof body.request.eventLimit).toBe('number');
    expect(body.request.eventLimit).toBeGreaterThan(0);
    expect(body.request.includeRawEvents).toBe(false);
    expect(body.request.includeProcessDetails).toBe(false);
    expect(body.request.includeRawSources).toBe(false);

    expect(body.access).toBeTruthy();
    expect(['development-loopback', 'admin']).toContain(body.access.mode);
    // Default request → redacted view.
    expect(body.access.redaction).toBe('redacted');
    expect(typeof body.access.rawAllowed).toBe('boolean');

    // 4. Identity (§1.3 identity block).
    expect(body.identity.conversationId).toBe(convId);
    expect(body.identity.provider).toBe('claude');

    // 5. Summary — healthy.
    expect(body.summary.health).toBe('healthy');
    expect(body.summary.highestSeverity).toBe('pass');
    expect(body.summary.errorCount).toBe(0);
    expect(body.summary.warnCount).toBe(0);
    expect(['idle_alive', 'idle_dead']).toContain(body.summary.primaryPhase);
    expect(body.summary.canSubmit).toBe(true);
    expect(typeof body.summary.lastSeq).toBe('number');
    expect(body.summary.lastSeq).toBeGreaterThan(0);
    expect(typeof body.summary.lastEventType).toBe('string');

    // 6. Sources — harness_events is the anchor and must be available.
    expect(body.sources).toBeTruthy();
    const harnessSnapshot = body.sources.harness_events;
    expect(harnessSnapshot).toBeTruthy();
    expect(harnessSnapshot.source).toBe('harness_events');
    expect(harnessSnapshot.available).toBe(true);
    expect(harnessSnapshot.ok).toBe(true);
    expect(harnessSnapshot.stale).toBe(false);

    const harnessFacts = harnessSnapshot.facts;
    expect(harnessFacts).toBeTruthy();
    expect(harnessFacts.source).toBe('harness_events');
    expect(harnessFacts.ids.conversationId).toBe(convId);
    expect(harnessFacts.sessionKnown).toBe(true);
    expect(harnessFacts.hasEventHistory).toBe(true);
    expect(RUNTIME_PHASES.has(harnessFacts.phase)).toBe(true);
    expect(harnessFacts.phase).toBe(body.summary.primaryPhase);
    expect(harnessFacts.turnActive).toBe(false);
    expect(harnessFacts.canSubmit).toBe(true);

    // Default redaction: raw must NOT be present without explicit raw access.
    expect(harnessSnapshot.raw).toBeUndefined();

    // 7. Invariants — runtime_authority_consensus must pass on a healthy turn.
    expect(Array.isArray(body.invariants)).toBe(true);
    expect(body.invariants.length).toBeGreaterThan(0);

    for (const inv of body.invariants) {
      expect(typeof inv.id).toBe('string');
      expect(SEVERITIES.has(inv.severity)).toBe(true);
      expect(typeof inv.ok).toBe('boolean');
      // Healthy case: nothing should be at error or warn severity.
      expect(['pass', 'info', 'skipped']).toContain(inv.severity);
    }

    const consensus = body.invariants.find(
      (i: any) => i.id === 'runtime_authority_consensus',
    );
    expect(consensus).toBeTruthy();
    expect(consensus.severity).toBe('pass');
    expect(consensus.ok).toBe(true);
    expect(consensus.anchorSource).toBe('harness_events');

    // 8. Events window — non-empty and monotonic by seq.
    expect(body.events).toBeTruthy();
    expect(body.events.window).toBeTruthy();
    expect(typeof body.events.window.limit).toBe('number');
    expect(typeof body.events.window.returned).toBe('number');
    expect(body.events.window.returned).toBeGreaterThan(0);
    expect(Array.isArray(body.events.items)).toBe(true);
    expect(body.events.items.length).toBe(body.events.window.returned);

    let prevSeq = -Infinity;
    for (const item of body.events.items) {
      expect(typeof item.seq).toBe('number');
      expect(typeof item.type).toBe('string');
      // Default redaction: raw payloads must NOT be present.
      expect(item.raw).toBeUndefined();
      expect(item.seq).toBeGreaterThan(prevSeq);
      prevSeq = item.seq;
    }
    expect(body.events.window.lastSeq).toBe(body.summary.lastSeq);

    // 9. Recommendations exists (may be empty for healthy case).
    expect(Array.isArray(body.recommendations)).toBe(true);
  });
});
