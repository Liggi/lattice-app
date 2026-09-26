/**
 * Cold-Load Multi-Turn — Behavioral Tests
 *
 * Reproduces the bug where loading directly onto a multi-turn session shows
 * only the most recent turn's messages. Earlier turns are missing until the
 * user navigates away and back (or scrolls up).
 *
 * Root cause: SSE replay scopes to the most recent turn on initial connection
 * (afterSeq=0 in sse-handler.ts). The client's onConnected fallback checks
 * "did any SSE events arrive?" — since the last turn's events DID arrive,
 * it skips the history fetch (use-session.ts). Older turns are only loadable
 * via the IntersectionObserver → fetchHistory scroll-up path, which depends
 * on the top sentinel being visible. When the last turn's content fills the
 * viewport, the sentinel is above the fold and older messages never load.
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

// Long response that fills the viewport (default 1280×720), pushing the
// load-more sentinel above the fold so the IntersectionObserver won't fire.
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
// Cold-load multi-turn session
// ============================================================================

test.describe('Cold-Load Multi-Turn Sessions', () => {
  test.beforeEach(async () => {
    await resetServer();
  });

  test('cold-loading a multi-turn session shows messages from all turns', async ({ page }) => {
    const convId = await seedConversation();

    // Turn 1: short messages
    await injectMessage(convId, 'user', 'What is the architecture of this project?');
    await injectMessage(convId, 'assistant', 'The project uses a client-server architecture with SSE for real-time updates.');
    await injectTurnEnd(convId);

    // Turn 2: long response that fills the viewport
    await injectMessage(convId, 'user', 'Can you show me the full implementation details?');
    await injectMessage(convId, 'assistant', LONG_RESPONSE);
    await injectTurnEnd(convId);

    // Cold load — navigate directly to the session URL.
    // No in-memory session exists, so the SSE handler recovers from storage,
    // scopes replay to the last turn, and delivers only Turn 2's events.
    await page.goto(`/c/${convId}`);

    // Turn 2 should be visible (SSE replay delivers it)
    await expect(
      page.getByTestId('user-message').filter({ hasText: 'Can you show me the full implementation details?' }),
    ).toBeVisible({ timeout: 10000 });

    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Architecture Overview' }),
    ).toBeVisible({ timeout: 10000 });

    // Turn 1 should ALSO be visible — this is the assertion that catches the bug.
    // SSE only replayed Turn 2. The onConnected fallback skipped the history fetch
    // because Turn 2's events made lastSeqRef > 0. The IntersectionObserver can't
    // fire because the long Turn 2 response pushed the load-more sentinel above
    // the fold. First-turn messages are missing until the user scrolls up.
    await expect(
      page.getByTestId('user-message').filter({ hasText: 'What is the architecture of this project?' }),
    ).toBeVisible({ timeout: 10000 });

    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'client-server architecture with SSE' }),
    ).toBeVisible({ timeout: 10000 });
  });
});
