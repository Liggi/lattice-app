/**
 * Cold-Load No Pop-In — Behavioral Tests
 *
 * Captures two tails of the same architectural flaw: the client's pagination
 * and entry-animation policies are driven by viewport geometry and "have I
 * seen this ID?" heuristics, not by semantic hydration state.
 *
 * Symptom A — short last turn (this bug):
 *   On mobile, opening an older multi-turn session makes events visibly pop
 *   in one-by-one. The top sentinel is inside the IntersectionObserver's
 *   200px band at mount, so pagination fires automatically. Each paginated
 *   batch grows the message count, so useMessageAnimation treats every
 *   backfilled user message as "new" and applies the animate-message-in
 *   stagger. Historical content animates as if it were live.
 *
 * Symptom B — long last turn (bug #51, still open):
 *   When the last turn fills the viewport, the sentinel is above the fold
 *   at mount, the IntersectionObserver never fires, and older turns are
 *   invisible until the user manually scrolls up.
 *
 * Same root cause: there's no explicit "hydration" phase separating
 * "catching up on session state" from "reacting to live events or user
 * intent." Animation and pagination both key on accidents of geometry.
 *
 * These tests assert the user-visible invariants a correct design must
 * satisfy: (1) all turns visible shortly after cold load, regardless of
 * last-turn size; (2) historical messages never animate.
 *
 * When the fix lands, these should pass and contracts/51-cold-load-multi-turn.spec.ts
 * (which asserts a subset of this) can be removed.
 */

import { test, expect, type Page } from '@playwright/test';

const BASE_URL = `http://localhost:${process.env.TEST_PORT ?? '4200'}`;

// -- Test infrastructure helpers --

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
  await fetch(`${BASE_URL}/api/test/inject-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, role, content }),
  });
}

/** Inject a single turn:end event to create a turn boundary in storage. */
async function injectTurnEnd(sessionId: string) {
  await fetch(`${BASE_URL}/api/test/inject-events/${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 1 }),
  });
}

/**
 * Installs a MutationObserver before the app boots that records every time
 * an element gains an entry-animation class. Historical messages (rendered
 * during cold-load hydration) must NEVER be flagged — they're being caught
 * up on, not arriving live.
 *
 * Two classes drive entry animations on messages:
 *   - `animate-message-in`: user-message slide-in (stagger-indexed)
 *   - `streaming-message`: assistant-message per-block slide-in, captured at
 *     mount from MessageItem's isStreaming prop
 *
 * Both must be silenced during hydration, so both are observed here.
 *
 * We record captures on `window.__entryAnimationCaptures` so the test can
 * assert nothing animated across the entire cold-load window without
 * relying on timing.
 */
async function installAnimationObserver(page: Page) {
  await page.addInitScript(() => {
    const win = window as unknown as {
      __entryAnimationCaptures: Array<{ id: string | null; klass: string; when: number }>;
    };
    win.__entryAnimationCaptures = [];
    const classes = ['animate-message-in', 'streaming-message'];

    const captureIfAnimated = (node: Element) => {
      if (!(node instanceof HTMLElement)) return;
      for (const klass of classes) {
        if (node.classList.contains(klass)) {
          const messageId =
            node.getAttribute('data-message-id') ??
            node.closest('[data-message-id]')?.getAttribute('data-message-id') ??
            null;
          win.__entryAnimationCaptures.push({
            id: messageId,
            klass,
            when: performance.now(),
          });
        }
      }
    };

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              captureIfAnimated(node);
              for (const klass of classes) {
                node.querySelectorAll(`.${klass}`).forEach(captureIfAnimated);
              }
            }
          });
        } else if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          captureIfAnimated(mutation.target as Element);
        }
      }
    });

    const startObserver = () => {
      if (!document.body) {
        requestAnimationFrame(startObserver);
        return;
      }
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
    };
    startObserver();
  });
}

async function getAnimationCaptures(page: Page): Promise<Array<{ id: string | null; klass: string; when: number }>> {
  return await page.evaluate(() => {
    const win = window as unknown as {
      __entryAnimationCaptures: Array<{ id: string | null; klass: string; when: number }>;
    };
    return win.__entryAnimationCaptures ?? [];
  });
}

// Long response (~600 words) to make the LAST turn tall enough to push the
// load-more sentinel above the fold at mount — same content shape as #51.
const LONG_RESPONSE = `Here is the full implementation:

## Architecture Overview

The system uses a layered architecture with the following components:

### Layer 1: Transport

The transport layer handles SSE connections, HTTP requests, and WebSocket communication between the client and server. It manages connection lifecycle including reconnection logic, heartbeat monitoring, and event serialization. Each client maintains a persistent SSE connection for real-time event streaming, with automatic reconnection when the connection drops.

### Layer 2: Session Management

Sessions are tracked in-memory with SQLite-backed persistence for durability across restarts. The SessionManager coordinates process lifecycle, event routing, and storage writes. Each session has an EventLog that buffers recent events in memory and delegates to persistent storage for older ones that have been evicted from the in-memory window.

### Layer 3: Process Daemon

The ProcessDaemon owns PTY sessions and manages CLI processes through Unix domain sockets. It runs as a separate process from the web server, which means the daemon survives server restarts and preserves active sessions. The daemon handles process spawning, signal forwarding, and stdout/stderr multiplexing.

### Layer 4: UI Layer

React frontend with real-time updates via Server-Sent Events. Uses a reducer pattern for event state management with built-in deduplication and scroll-up pagination support. The MessageList component renders events grouped by turn with collapsible tool use sections and a block budget system that controls how many messages are rendered at once.

### Implementation Details

The event pipeline follows this flow:

1. CLI process writes newline-delimited JSON events to stdout
2. ProcessDaemon reads stdout and forwards events via Unix socket
3. Server receives events, parses them, and writes to the EventLog
4. EventLog stores events in memory and broadcasts to SSE subscribers
5. EventLog also writes events to SQLite for persistent storage
6. SSE handler serializes events as SSE format and writes to HTTP response
7. Client SSEClient receives events and dispatches to the React reducer
8. Reducer updates state, React re-renders with new messages

### Key Design Decisions

The separation of daemon and server processes ensures session continuity across deploys. The EventLog's dual in-memory and persistent storage design provides both low-latency streaming and durable history. The block budget system in the UI prevents rendering thousands of messages at once, which would cause performance issues in long-running sessions.

Error handling follows a "loud failure" principle — silent fallbacks are avoided in favor of explicit error states that are visible to the user. The SSE connection includes automatic reconnection with gap detection, ensuring no events are lost even during brief network interruptions.`;

// ============================================================================

test.describe('Cold-Load — no pop-in, no missing turns', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('short last turn: all turns visible with no entry animations', async ({ page }) => {
    await installAnimationObserver(page);

    const convId = await seedConversation();

    // Three short turns. The last turn is small enough that the load-more
    // sentinel naturally sits within the viewport at mount — exactly the
    // condition that makes the IntersectionObserver auto-paginate backward
    // today, producing the staggered pop-in effect.
    await injectMessage(convId, 'user', 'Question one: what is the project?');
    await injectMessage(convId, 'assistant', 'It is a dashboard for managing sessions.');
    await injectTurnEnd(convId);

    await injectMessage(convId, 'user', 'Question two: how does it work?');
    await injectMessage(convId, 'assistant', 'Events stream from a daemon into a web UI.');
    await injectTurnEnd(convId);

    await injectMessage(convId, 'user', 'Question three: anything else?');
    await injectMessage(convId, 'assistant', 'Nope, that covers it.');
    await injectTurnEnd(convId);

    // Cold load.
    await page.goto(`/c/${convId}`);

    // All three turns must be visible shortly after cold load — not after
    // the user scrolls up, not after multiple paginated batches stagger in.
    await expect(
      page.getByTestId('user-message').filter({ hasText: 'Question three' }),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByTestId('user-message').filter({ hasText: 'Question two' }),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByTestId('user-message').filter({ hasText: 'Question one' }),
    ).toBeVisible({ timeout: 10000 });

    // Historical content must not have animated in. The MutationObserver
    // installed before page boot records every `animate-message-in`
    // application; if any fired during cold load, the pop-in bug is live.
    const captures = await getAnimationCaptures(page);
    expect(
      captures,
      `historical messages should not animate on cold load, but entry animations fired on: ${JSON.stringify(captures)}`,
    ).toEqual([]);
  });

  test('reload with unterminated last turn: assistant blocks do not animate', async ({ page }) => {
    await installAnimationObserver(page);

    const convId = await seedConversation();

    // A prior completed turn.
    await injectMessage(convId, 'user', 'First question?');
    await injectMessage(convId, 'assistant', 'First answer.');
    await injectTurnEnd(convId);

    // A second turn where the assistant content is recorded but no turn:end
    // was ever written — the session was closed mid-stream or the process
    // died after emitting content. On cold load, deriveStatus walks backward
    // from the final `content` event and returns 'streaming', so the legacy
    // code propagated isStreaming=true to MessageItem, which then captured
    // mountedWhileStreaming=true in its useRef and animated historical
    // content via `streaming-message` / blockSlideIn. The hydrationPhase
    // gate is what blocks that.
    await injectMessage(convId, 'user', 'Second question?');
    await injectMessage(convId, 'assistant', 'Second answer that was never finalized.');
    // NOTE: intentionally no injectTurnEnd — last event is `content`.

    await page.goto(`/c/${convId}`);

    await expect(
      page.getByTestId('user-message').filter({ hasText: 'First question' }),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Second answer' }),
    ).toBeVisible({ timeout: 10000 });

    const captures = await getAnimationCaptures(page);
    expect(
      captures,
      `historical messages should not animate on cold load, but entry animations fired on: ${JSON.stringify(captures)}`,
    ).toEqual([]);
  });

  test('long last turn: earlier turns still visible (subsumes #51)', async ({ page }) => {
    await installAnimationObserver(page);

    const convId = await seedConversation();

    await injectMessage(convId, 'user', 'Short question from turn one.');
    await injectMessage(convId, 'assistant', 'Short answer from turn one.');
    await injectTurnEnd(convId);

    // Turn 2's long response fills the viewport, pushing the load-more
    // sentinel above the fold. Today that means the IntersectionObserver
    // never fires and Turn 1 is never loaded.
    await injectMessage(convId, 'user', 'Show me the full implementation details.');
    await injectMessage(convId, 'assistant', LONG_RESPONSE);
    await injectTurnEnd(convId);

    await page.goto(`/c/${convId}`);

    // Turn 2 should be visible (SSE replay delivers it).
    await expect(
      page.getByTestId('user-message').filter({ hasText: 'Show me the full implementation' }),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Architecture Overview' }),
    ).toBeVisible({ timeout: 10000 });

    // Turn 1 must ALSO be visible without the user scrolling. This is the
    // #51 invariant — older turns must not depend on sentinel geometry.
    await expect(
      page.getByTestId('user-message').filter({ hasText: 'Short question from turn one' }),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Short answer from turn one' }),
    ).toBeVisible({ timeout: 10000 });

    // Whatever path brought Turn 1 into view, it must not have animated.
    const captures = await getAnimationCaptures(page);
    expect(
      captures,
      `historical messages should not animate on cold load, but entry animations fired on: ${JSON.stringify(captures)}`,
    ).toEqual([]);
  });
});
