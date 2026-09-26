/**
 * Cold-Load of a Long Recovered History — Tail, Not Head
 *
 * Regression contract for the wrong-end cold-load replay defect.
 *
 * Setup reproduces a server-restart recovery of a LONG session:
 *   - An OLD turn at the head of the log (seq ~1-3).
 *   - ~12,000 contentless padding turn:end events after it, pushing the log
 *     past the 10,000-event storage read window.
 *   - A NEW turn at the tail of the log (the most recent real content).
 *   - The session is then destroyed from memory (simulated restart), so the
 *     cold SSE connect (?after=0) recovers from storage with an EMPTY
 *     in-memory buffer.
 *
 * Defect (pre-fix): EventLog.since(0) fell through to a storage read scoped
 * to the OLDEST 10k events (`WHERE seq > 0 ... ORDER BY seq ASC LIMIT 10000`).
 * The sse-handler's last-contentful-turn scan then ran over that head window,
 * whose only content is the OLD turn — so the client rendered the OLD turn as
 * if it were the latest message.
 *
 * Invariant: the cold SSE replay payload must contain only tail-window
 * content (the fix reads the TAIL window instead), and the UI must render the
 * NEWEST turn as the latest message. Old turns remain legitimately reachable
 * via the /history fetch (scrollback), so the spec asserts on the SSE payload
 * and on message ORDER, not on the old turn's absence from the DOM.
 */

import { test, expect } from '@playwright/test';

const BASE_URL = `http://localhost:${process.env.TEST_PORT ?? '4200'}`;

async function resetServer() {
  await fetch(`${BASE_URL}/api/test/reset`, { method: 'POST' });
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

async function injectMessage(sessionId: string, role: string, content: string) {
  const resp = await fetch(`${BASE_URL}/api/test/inject-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, role, content }),
  });
  if (!resp.ok) throw new Error(`inject-message failed: ${await resp.text()}`);
}

/** Bulk-inject `count` contentless turn:end padding events into storage. */
async function injectPadding(sessionId: string, count: number) {
  const resp = await fetch(`${BASE_URL}/api/test/inject-events/${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count }),
  });
  if (!resp.ok) throw new Error(`inject-events failed: ${await resp.text()}`);
}

/** Remove the session from the SessionManager's memory (simulated restart),
 *  forcing the next SSE connect through recoverFromStorage with an empty
 *  in-memory buffer. */
async function destroySession(sessionId: string) {
  await fetch(`${BASE_URL}/api/test/destroy-session/${sessionId}`, { method: 'POST' });
}

const OLD_USER = 'OLDEST question buried at the head of the log';
const OLD_ASSISTANT = 'OLDEST answer that only a head-window read would surface';
const NEW_USER = 'NEWEST question at the tail of the log';
const NEW_ASSISTANT = 'NEWEST answer the cold client must render as latest';

test.describe('Cold-load of a long recovered history serves the TAIL', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('renders the newest turn, never the head-window turn', async ({ page }) => {
    const convId = await seedConversation();

    // Remove the session from memory BEFORE seeding events. inject-message
    // prefers a live in-memory EventLog whose seq counter knows nothing about
    // the padding rows written directly to storage — seqs collide and the
    // tail-turn events are silently dropped (INSERT OR IGNORE). With no live
    // log, every injection below takes the direct-storage path with correct
    // sequential seqs, and the SSE connect exercises real storage recovery.
    await destroySession(convId);

    // Head turn (real content), then a turn boundary.
    await injectMessage(convId, 'user', OLD_USER);
    await injectMessage(convId, 'assistant', OLD_ASSISTANT);
    await injectPadding(convId, 1);

    // ~12k contentless turn:end events — pushes the log past the 10k storage
    // read window. A head read would stop at seq 10000, containing only the
    // OLD turn's content; a tail read reaches the NEW turn below.
    await injectPadding(convId, 12000);

    // Tail turn (real content) + its turn boundary.
    await injectMessage(convId, 'user', NEW_USER);
    await injectMessage(convId, 'assistant', NEW_ASSISTANT);
    await injectPadding(convId, 1);

    // Cold SSE connect (?after=0) against the recovered, empty in-memory log.
    // Capture the raw replay payload — this is exactly what the fix scopes.
    const controller = new AbortController();
    const sse = await fetch(`${BASE_URL}/api/harness/${convId}/events?after=0`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(sse.ok).toBe(true);
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let replay = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !replay.includes('NEWEST answer the cold client')) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((r) => setTimeout(() => r(null), Math.max(50, deadline - Date.now()))),
      ]);
      if (!chunk || chunk.done) break;
      replay += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();

    expect(replay).toContain('replay_meta');
    expect(replay).toContain('NEWEST answer');
    expect(replay).not.toContain('OLDEST answer');

    // Cold load in the browser: the newest turn renders, and renders LAST.
    await page.goto(`/c/${convId}`);
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'NEWEST answer' }),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByTestId('user-message').filter({ hasText: 'NEWEST question' }),
    ).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('assistant-message').last()).toContainText(
      'NEWEST answer',
      { timeout: 10000 },
    );
  });
});
