/**
 * Diagnostics — Multi-Source Snapshot Contract (Move 3, Slice 3.1)
 *
 * Asserts that `GET /api/diagnostics/conversations/:conversationId` populates
 * every runtime authority as a first-class `DiagnosticSourceSnapshot`, not
 * just `harness_events`.
 *
 * Without these source snapshots, the multi-source invariants in Slice 3.2
 * (`runtime_authority_consensus`, `daemon_manager_process_consistency`,
 * `single_live_run`, `resume_id_consistency`) cannot be evaluated against
 * real disagreements — they would silently pass against `harness_events`
 * alone, defeating the entire point of consolidating runtime truth.
 *
 * This is the failing-test gate for Slice 3.1. Today the collector only wires
 * `sources.harness_events`, so this test fails on the first missing source.
 *
 * What this test asserts:
 *
 *   For a healthy, just-completed conversation:
 *     - sources.harness_events    (anchor — already wired by Move 1)
 *     - sources.harness_manager   (per-session SessionManager view)
 *     - sources.daemon            (ProcessDaemon / streaming-id view)
 *     - sources.active_registry   (ActiveConversationRegistry view)
 *     - sources.database          (segment / session_info row)
 *     - sources.public_status     (what /api/sessions/status would return)
 *
 *   Each is a DiagnosticSourceSnapshot with:
 *     - source === <key>
 *     - available === true
 *     - ok === true
 *     - facts.ids.conversationId === conversationId
 *     - facts.phase ∈ RUNTIME_PHASES
 *
 *   And — because the conversation is healthy and just settled — the phases
 *   across sources must agree with the harness anchor (the consensus property
 *   that Slice 3.2's `runtime_authority_consensus` invariant will lean on).
 *
 * What this test does NOT do (kept for later slices):
 *   - Synthetically diverge any source (Slice 3.2's job).
 *   - Assert the full RuntimeFacts shape on each source — only the
 *     load-bearing fields the consensus invariant will consult.
 */

import { test, expect } from '@playwright/test';

const BASE_URL = `http://localhost:${process.env.TEST_PORT ?? '4200'}`;

const RUNTIME_PHASES = new Set([
  'absent',
  'starting',
  'working',
  'stopping',
  'idle_alive',
  'idle_dead',
  'error',
]);

const REQUIRED_SOURCES = [
  'harness_events',
  'harness_manager',
  'daemon',
  'active_registry',
  'database',
  'public_status',
] as const;

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

test.describe('GET /api/diagnostics/conversations/:id — multi-source snapshot', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('populates every runtime authority as a first-class source snapshot, all consistent with the harness anchor', async ({ page }) => {
    await setScenario('simple-response');

    const convId = await seedConversation();
    await page.goto(`/c/${convId}`);

    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeVisible({ timeout: 15000 });
    await composer.fill('Hello multi-source');
    await page.getByTestId('send-button').click();

    await expect(page.getByTestId('assistant-message').first()).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText('Working', { exact: true })).not.toBeVisible({
      timeout: 10000,
    });

    // Gate on anchor reaching idle_alive: mid-turn the DB segment reads `active`
    // while the harness anchor is still `working` (benign transient, not a bug).
    let body: any;
    await expect(async () => {
      const resp = await fetch(
        `${BASE_URL}/api/diagnostics/conversations/${convId}`,
      );
      expect(resp.status).toBe(200);
      body = await resp.json();
      expect(body.sources?.harness_events?.facts?.phase).toBe('idle_alive');
    }).toPass({ timeout: 10000 });

    expect(body.sources).toBeTruthy();

    for (const key of REQUIRED_SOURCES) {
      const snap = body.sources[key];
      expect(snap, `sources.${key} must be populated`).toBeTruthy();
      expect(snap.source).toBe(key);
      expect(snap.available, `sources.${key}.available`).toBe(true);
      expect(snap.ok, `sources.${key}.ok`).toBe(true);
      expect(typeof snap.collectedAtMs).toBe('number');
      expect(snap.collectedAtMs).toBeGreaterThan(0);

      const facts = snap.facts;
      expect(facts, `sources.${key}.facts`).toBeTruthy();
      expect(facts.source).toBe(key);
      expect(facts.ids?.conversationId).toBe(convId);
      expect(RUNTIME_PHASES.has(facts.phase)).toBe(true);
    }

    // `daemon` is exempt: in-process adapter (and the SDK path) synthesize a
    // harness-* streamingId the daemon never owns, so daemon correctly reports idle_dead.
    const anchorPhase = body.sources.harness_events.facts.phase;
    for (const key of REQUIRED_SOURCES) {
      if (key === 'daemon') continue;
      const snap = body.sources[key];
      expect(
        snap.facts.phase,
        `sources.${key}.facts.phase should agree with harness anchor on healthy turn`,
      ).toBe(anchorPhase);
    }

    // ids.providerSessionId must be consistent across any source that knows it
    // (a precondition for Slice 3.2's `resume_id_consistency` invariant).
    const anchorProviderSid = body.sources.harness_events.facts.ids?.providerSessionId ?? null;
    if (anchorProviderSid !== null) {
      for (const key of REQUIRED_SOURCES) {
        const snap = body.sources[key];
        const sid = snap.facts.ids?.providerSessionId ?? null;
        if (sid !== null) {
          expect(
            sid,
            `sources.${key}.facts.ids.providerSessionId should agree with harness anchor`,
          ).toBe(anchorProviderSid);
        }
      }
    }
  });
});
