/**
 * Behavioral Test Server
 *
 * Boots a real LatticeServer and pins an in-process ScenarioProcessAdapter as
 * the harness session manager's ProcessAdapter. The adapter replays scenario
 * JSON (from test/behavioral/scenarios/) directly, replacing the ProcessDaemon
 * + claude-stub.mjs executable pair. The stub-equivalent process stays alive
 * across turns, enabling multi-turn behavioral contract testing via API +
 * Playwright.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// =============================================================================
// PHASE 1: Ephemeral HOME (MUST happen before any app imports)
// =============================================================================

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-behavioral-'));
const TEST_PORT = Number(process.env.TEST_PORT ?? '4200');
const TEST_DAEMON_SOCKET = path.join(TEST_HOME, 'lattice-daemon.sock');

process.env.HOME = TEST_HOME;
// An inherited LATTICE_CONFIG_DIR (every agent shell on a live Lattice has one)
// would otherwise point this server, and /api/test/reset, at the live data.
process.env.LATTICE_CONFIG_DIR = path.join(TEST_HOME, '.lattice');
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.BEHAVIORAL_LOG_LEVEL ?? 'warn';

// Isolate harness init from prod daemon socket.
process.env.LATTICE_DAEMON_SOCKET = TEST_DAEMON_SOCKET;
process.env.CUI_DAEMON_SOCKET = TEST_DAEMON_SOCKET;

// Default scenario — tests can override via /api/test/set-scenario before spawning
const scenariosDir = path.join(process.cwd(), 'test', 'behavioral', 'scenarios');
process.env.AGENT_STUB_SCENARIO = path.join(scenariosDir, 'simple-response.json');

fs.mkdirSync(path.join(TEST_HOME, '.lattice', 'logs'), { recursive: true });
fs.mkdirSync(path.join(TEST_HOME, '.claude', 'projects'), { recursive: true });

fs.writeFileSync(
  path.join(TEST_HOME, '.lattice', 'config.json'),
  JSON.stringify({ server: { host: '127.0.0.1', port: TEST_PORT } })
);

// =============================================================================
// PHASE 1b: Stale-build gate
//
// This suite exercises dist/web — the BUILT frontend — not src/web. A green
// run therefore only vouches for commits that have been built; on 2026-08-28
// a broken client commit passed 84/84 because dist still held the previous
// build. Refuse to boot when any file under src/web is newer than the build,
// so staleness fails loudly instead of silently testing the wrong code.
// =============================================================================

if (process.env.BEHAVIORAL_ALLOW_STALE_DIST !== '1') {
  const distIndex = path.join(process.cwd(), 'dist', 'web', 'index.html');
  const srcWebDir = path.join(process.cwd(), 'src', 'web');
  if (!fs.existsSync(distIndex)) {
    console.error(
      `[behavioral] dist/web/index.html not found — run \`pnpm build\` before the behavioral suite.`
    );
    process.exit(1);
  }
  const builtAt = fs.statSync(distIndex).mtimeMs;
  let newestSrc: string | null = null;
  let newestSrcMtime = 0;
  for (const entry of fs.readdirSync(srcWebDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    const mtime = fs.statSync(full).mtimeMs;
    if (mtime > newestSrcMtime) {
      newestSrcMtime = mtime;
      newestSrc = full;
    }
  }
  if (newestSrcMtime > builtAt) {
    console.error(
      `[behavioral] dist/web is STALE: ${newestSrc} is newer than the build ` +
        `(${new Date(newestSrcMtime).toISOString()} > ${new Date(builtAt).toISOString()}).\n` +
        `This suite tests the BUILT frontend — a green run against a stale build proves nothing ` +
        `about your client changes. Run \`pnpm build\`, then re-run. ` +
        `(Deliberate override: BEHAVIORAL_ALLOW_STALE_DIST=1)`
    );
    process.exit(1);
  }
}

// =============================================================================
// PHASE 2: Dynamic imports (after HOME is set)
// =============================================================================

const { LatticeServer } = await import('../../src/lattice-server.js');
const { ConversationService } = await import('../../src/services/sessions/conversation-service.js');
const { SessionInfoService } = await import('../../src/services/sessions/session-info-service.js');
const { InsightsEngine } = await import('../../src/services/insights/insights-engine.js');
const { TurnRepository } = await import('../../src/services/sessions/turn-repository.js');
const { CassetteAdapter } = await import('@liggi/agent-ui-harness/server');
const { ScenarioProcessAdapter } = await import('./scenario-process-adapter.js');
const { ProcessDaemon } = await import('../../src/process-daemon/process-daemon.js');

// =============================================================================
// PHASE 3: In-process daemon (socket placeholder — never used for spawns)
//
// lattice-server's setupHarness() unconditionally connects a ProcessManagerClient
// to the daemon socket. We start an in-process ProcessDaemon on the ephemeral
// socket to satisfy that connection. Poisoned executable path ensures any spawn
// that bypasses the ScenarioProcessAdapter pin (e.g. after a harness update)
// FAILS LOUDLY rather than silently running the real claude CLI.
// =============================================================================

const daemon = new ProcessDaemon({
  socketPath: TEST_DAEMON_SOCKET,
  claudeExecutablePath: '/nonexistent/claude-blocked-by-behavioral-tests',
});
await daemon.start();
console.log(`[behavioral] Test daemon ready on ${TEST_DAEMON_SOCKET} (harness-connection only)`);

// =============================================================================
// PHASE 4: Boot server
// =============================================================================

const server = new LatticeServer({ port: TEST_PORT });
const express = await import('express');
const app = server.getApp();

// Serve built static files
const distWebPath = path.join(process.cwd(), 'dist', 'web');
const indexPath = path.join(distWebPath, 'index.html');

if (!fs.existsSync(indexPath)) {
  console.error(`[behavioral] ERROR: dist/web/index.html not found. Run 'pnpm build' first.`);
  process.exit(1);
}

const distRouter = express.Router();
distRouter.use(express.default.static(distWebPath));
app.use(distRouter);

// Stub expensive polling endpoints
app.get('/api/system/commands', (_req: any, res: any) => res.json({ commands: [] }));

// =============================================================================
// Test control endpoints
// =============================================================================

const cassettesDir = path.join(process.cwd(), 'test', 'behavioral', 'cassettes');
let originalAdapter: any = null; // Stashed when cassette is active

// Set cassette for next spawn — replaces the ProcessAdapter with CassetteAdapter
app.post('/api/test/set-cassette', (req: any, res: any) => {
  const { cassette, timescale } = req.body as { cassette?: string; timescale?: number };
  if (!cassette) {
    res.status(400).json({ error: 'cassette name required' });
    return;
  }
  const cassettePath = path.join(cassettesDir, `${cassette}.jsonl`);
  if (!fs.existsSync(cassettePath)) {
    res.status(404).json({ error: `Cassette not found: ${cassettePath}` });
    return;
  }

  const harnessRuntime = (server as any).harnessRuntime;
  if (!harnessRuntime?.sessionManager) {
    res.status(500).json({ error: 'Harness not initialized' });
    return;
  }

  const sm = harnessRuntime.sessionManager;
  const content = fs.readFileSync(cassettePath, 'utf-8');
  const adapter = CassetteAdapter.fromString(content, { timescale: timescale ?? 0.05 });

  // Stash original adapter for restore on reset
  if (!originalAdapter) {
    originalAdapter = (sm as any).adapter;
  }
  (sm as any).adapter = adapter;

  console.log(`[behavioral] Cassette set: ${cassette} (timescale: ${timescale ?? 0.05})`);
  res.json({ ok: true, path: cassettePath });
});

// Set scenario for next spawn
app.post('/api/test/set-scenario', (req: any, res: any) => {
  const { scenario } = req.body as { scenario?: string };
  if (!scenario) {
    res.status(400).json({ error: 'scenario name required' });
    return;
  }
  const scenarioFile = path.join(scenariosDir, `${scenario}.json`);
  if (!fs.existsSync(scenarioFile)) {
    res.status(404).json({ error: `Scenario not found: ${scenarioFile}` });
    return;
  }
  // Update env for future spawns — ScenarioProcessAdapter reads it at spawn time
  process.env.AGENT_STUB_SCENARIO = scenarioFile;
  console.log(`[behavioral] Scenario set to: ${scenario}`);
  res.json({ ok: true, path: scenarioFile });
});

// Reset state between tests
app.post('/api/test/reset', async (_req: any, res: any) => {
  try {
    const registry = (server as any).activeConversationRegistry;
    if (registry?.clear) registry.clear();

    // Destroy all in-memory harness sessions so EventLogs don't leak between tests
    const sm = (server as any).harnessRuntime?.sessionManager;
    if (sm) {
      for (const id of sm.getSessionIds()) sm.destroy(id);
    }

    const convDb = (ConversationService.getInstance() as any).db;
    if (convDb) {
      convDb.exec('DELETE FROM conversation_segments');
      convDb.exec('DELETE FROM conversations');
    }

    const harnessRuntime = (server as any).harnessRuntime;
    if (harnessRuntime?.eventStorage) {
      const evtDb = (harnessRuntime.eventStorage as any).db;
      if (evtDb) evtDb.exec('DELETE FROM harness_events');
    }

    const sessionInfoDb = (SessionInfoService.getInstance() as any).db;
    if (sessionInfoDb) {
      sessionInfoDb.exec('DELETE FROM session_turns');
      sessionInfoDb.exec('DELETE FROM session_insights');
      sessionInfoDb.exec('DELETE FROM sessions');
    }

    // Reset scenario to default
    process.env.AGENT_STUB_SCENARIO = path.join(scenariosDir, 'simple-response.json');

    // Restore original adapter if cassette was active
    if (originalAdapter) {
      const sm = (server as any).harnessRuntime?.sessionManager;
      if (sm) (sm as any).adapter = originalAdapter;
      originalAdapter = null;
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('[behavioral] Reset error:', error);
    res.status(500).json({ error: 'Reset failed' });
  }
});

// Seed a conversation (creates conv record + segment so harness /start can resolve it)
app.post('/api/test/seed-conversation', async (req: any, res: any) => {
  try {
    const { provider, workingDirectory } = req.body as {
      provider?: string;
      workingDirectory?: string;
    };

    const convService = ConversationService.getInstance();
    const cwd = workingDirectory ?? process.cwd();
    const usePending = (req.body as Record<string, unknown>).pending === true;

    // createConversation generates its own conv-* ID and requires a providerSessionId
    // for the initial segment. Use a placeholder — the harness /start route will
    // create a real session when the first message is sent.
    // When `pending: true`, use `pending-` prefix to match production behavior
    // (production creates conversations with pending- that should be updated on run:ready).
    const providerSessionId = usePending
      ? `pending-${Date.now()}`
      : `seed-${Date.now()}`;

    const { conversationId } = convService.createConversation({
      provider: (provider as 'claude') ?? 'claude',
      workingDirectory: cwd,
      providerSessionId,
      initialPrompt: '[test] seeded conversation',
    });

    // The sidebar query JOINs conversations with sessions — without a sessions row
    // the conversation won't appear in the sidebar at all.
    const sessionInfoService = SessionInfoService.getInstance();
    await sessionInfoService.updateSessionInfo(conversationId, { archived: false });

    res.json({ ok: true, conversationId });
  } catch (error) {
    console.error('[behavioral] Seed error:', error);
    res.status(500).json({ error: 'Seed failed' });
  }
});

// Inject a message directly into harness event storage
app.post('/api/test/inject-message', (req: any, res: any) => {
  try {
    const { sessionId, role, content } = req.body as {
      sessionId: string;
      role: string;
      content: string;
      timestamp?: string;
    };

    if (!sessionId || !role || !content) {
      res.status(400).json({ error: 'sessionId, role, and content required' });
      return;
    }

    const harnessRuntime = (server as any).harnessRuntime;
    const sm = harnessRuntime?.sessionManager;
    const storage = harnessRuntime?.eventStorage;
    if (!sm || !storage) {
      res.status(500).json({ error: 'Harness not initialized' });
      return;
    }

    // Prefer the live EventLog so SSE subscribers see the event in real time
    // (storage is also written via the EventLog's storage subscriber). Fall
    // back to a direct storage write only when there's no in-memory session
    // (e.g. post-destroy / post-restart fixtures).
    const log = sm.getLog(sessionId);
    const type = role === 'user' ? 'input:sent' : 'content';
    const data =
      role === 'user'
        ? { text: content }
        : { blocks: [{ type: 'text', text: content }] };

    let seq: number;
    if (log) {
      const event = log.append(type, data, 'test-inject', sessionId);
      seq = event.seq;
    } else {
      seq = storage.count(sessionId) + 1;
      storage.write({
        sessionId,
        runId: 'test-inject',
        seq,
        timestamp: Date.now(),
        type,
        data,
      });
    }

    res.json({ ok: true, messageId: `evt-${seq}` });
  } catch (error) {
    console.error('[behavioral] Inject message error:', error);
    res.status(500).json({ error: 'Inject failed' });
  }
});

// Seed insights for a session (for testing identity image + mission rendering)
app.post('/api/test/seed-insights', async (req: any, res: any) => {
  try {
    const { sessionId, context, theme, categories, tags, purpose, identityImage } = req.body as {
      sessionId: string;
      context?: { project?: string; area?: string; mission?: string; scope?: string };
      theme?: string;
      categories?: { primary: string; secondary: string[] };
      tags?: { complexity?: string };
      purpose?: string;
      identityImage?: string; // base64 JPEG data
    };

    if (!sessionId) {
      res.status(400).json({ error: 'sessionId required' });
      return;
    }

    const sessionInfoService = SessionInfoService.getInstance();
    const insightsEngine = new InsightsEngine(null, sessionInfoService);

    await insightsEngine.setInsightsRecord({
      session_id: sessionId,
      context: context ?? null,
      tags: tags ?? null,
      theme: theme ?? null,
      categories: (categories as import('../../src/types/session-categories.js').SessionCategorySet) ?? null,
      computed_at: new Date().toISOString(),
      stale: false,
      message_count: 1,
      patched_at: null,
      purpose: purpose ?? null,
    });

    if (identityImage) {
      await sessionInfoService.setIdentityImageIfMissing(sessionId, identityImage);
    }

    console.log(`[behavioral] Insights seeded for session: ${sessionId}`);
    res.json({ ok: true });
  } catch (error) {
    console.error('[behavioral] Seed insights error:', error);
    res.status(500).json({ error: 'Seed insights failed' });
  }
});

// Seed turns for a session (for testing insights panel timeline)
app.post('/api/test/seed-turns', async (req: any, res: any) => {
  try {
    const { sessionId, turns } = req.body as {
      sessionId: string;
      turns: Array<{
        turnNumber: number;
        timestamp?: string;
        headline: string;
        actions?: string[];
        tag?: string;
        icon?: string;
      }>;
    };

    if (!sessionId || !Array.isArray(turns) || turns.length === 0) {
      res.status(400).json({ error: 'sessionId and non-empty turns array required' });
      return;
    }

    const turnRepo = TurnRepository.getInstance();

    for (const turn of turns) {
      await turnRepo.save({
        id: `test-turn-${sessionId.slice(0, 8)}-${turn.turnNumber}`,
        session_id: sessionId,
        turn_number: turn.turnNumber,
        timestamp: turn.timestamp ?? new Date().toISOString(),
        headline: turn.headline,
        actions: JSON.stringify(turn.actions ?? ['Completed task']),
        tag: turn.tag ?? 'build',
        icon: turn.icon ?? '🔧',
        exit_code: 0,
        termination_reason: 'normal_completion',
        tool_count: 0,
        incomplete: 0,
      });
    }

    console.log(`[behavioral] ${turns.length} turns seeded for session: ${sessionId}`);
    res.json({ ok: true, count: turns.length });
  } catch (error) {
    console.error('[behavioral] Seed turns error:', error);
    res.status(500).json({ error: 'Seed turns failed' });
  }
});

// Force-kill a harness session's process (simulates idle timeout / process death)
app.post('/api/test/kill-session/:sessionId', (req: any, res: any) => {
  try {
    const { sessionId } = req.params;
    const harnessRuntime = (server as any).harnessRuntime;
    if (!harnessRuntime?.sessionManager) {
      res.status(500).json({ error: 'Harness not initialized' });
      return;
    }
    const sm = harnessRuntime.sessionManager;
    const sent = sm.signal(sessionId, 'SIGKILL');
    if (!sent) {
      res.status(404).json({ error: 'Session not found or process not alive' });
      return;
    }
    console.log(`[behavioral] Force-killed session process: ${sessionId}`);
    res.json({ ok: true });
  } catch (error) {
    console.error('[behavioral] Kill session error:', error);
    res.status(500).json({ error: 'Kill failed' });
  }
});

// Bulk-inject dummy harness events to simulate a long session.
// This pushes early events (like run:ready) outside the recovery window (last 50).
app.post('/api/test/inject-events/:sessionId', async (req: any, res: any) => {
  try {
    const { sessionId } = req.params;
    const { count } = req.body as { count: number };
    if (!count || count < 1) {
      res.status(400).json({ error: 'count required (positive integer)' });
      return;
    }

    const { default: Database } = await import('better-sqlite3');
    const dbPath = path.join(TEST_HOME, '.lattice', 'session-info.db');
    if (!fs.existsSync(dbPath)) {
      res.status(500).json({ error: 'Database not available' });
      return;
    }
    const msgDb = new Database(dbPath);
    msgDb.pragma('busy_timeout = 10000');
    let nextSeq: number;
    try {
      // Find the current max seq for this session
      const maxRow = msgDb.prepare(
        'SELECT MAX(seq) as maxSeq FROM harness_events WHERE session_id = ?'
      ).get(sessionId) as { maxSeq: number | null } | undefined;
      nextSeq = (maxRow?.maxSeq ?? 0) + 1;

      const insertStmt = msgDb.prepare(
        'INSERT OR IGNORE INTO harness_events (session_id, seq, run_id, timestamp, type, data, meta) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );

      const insertMany = msgDb.transaction(() => {
        const now = Date.now();
        for (let i = 0; i < count; i++) {
          insertStmt.run(
            sessionId,
            nextSeq + i,
            'padding-run',
            now + i,
            'turn:end',
            JSON.stringify({ reason: 'padding' }),
            null,
          );
        }
      });
      insertMany();
    } finally {
      msgDb.close();
    }

    console.log(`[behavioral] Injected ${count} padding events for session ${sessionId}`);
    res.json({ ok: true, count, startSeq: nextSeq });
  } catch (error) {
    console.error('[behavioral] Inject events error:', error);
    res.status(500).json({ error: 'Inject events failed' });
  }
});

// Destroy a session from the SessionManager's in-memory state.
// Simulates a server restart: the process is killed, the session is removed
// from memory, but the database (harness_events, conversations, segments)
// is preserved. The next /send will trigger the "Unknown session" auto-resume
// path, which must resolve the provider session ID from the DB.
app.post('/api/test/destroy-session/:sessionId', async (req: any, res: any) => {
  try {
    const { sessionId } = req.params;
    const harnessRuntime = (server as any).harnessRuntime;
    if (!harnessRuntime?.sessionManager) {
      res.status(500).json({ error: 'Harness not initialized' });
      return;
    }
    const sm = harnessRuntime.sessionManager;
    sm.destroy(sessionId);

    // Also clear from active conversation registry so the UI doesn't show stale state
    const registry = (server as any).activeConversationRegistry;
    if (registry?.remove) registry.remove(sessionId);

    console.log(`[behavioral] Destroyed session (simulated restart): ${sessionId}`);
    res.json({ ok: true });
  } catch (error) {
    console.error('[behavioral] Destroy session error:', error);
    res.status(500).json({ error: 'Destroy failed' });
  }
});

await server.start();

// Verify harness initialized
const harnessRuntime = (server as any).harnessRuntime;
if (!harnessRuntime) {
  console.error('[behavioral] ERROR: Harness not initialized');
  process.exit(1);
}

// Pin adapter — replaces daemon/SDK routing; cassette-swap stashes/restores this.
(harnessRuntime.sessionManager as any).adapter = new ScenarioProcessAdapter();
console.log('[behavioral] ScenarioProcessAdapter installed as session manager adapter');

// SPA catch-all
const routerStack = (app as any)._router?.stack;
if (routerStack) {
  for (let i = routerStack.length - 1; i >= 0; i--) {
    const layer = routerStack[i];
    if (layer.route && layer.route.path === '*' && layer.route.methods.get) {
      routerStack.splice(i, 1);
      break;
    }
  }
}
app.get('*', (_req: any, res: any) => res.sendFile(indexPath));

console.log(`[behavioral] Test server running on http://127.0.0.1:${TEST_PORT}`);

// Graceful shutdown
const shutdown = async () => {
  console.log('[behavioral] Shutting down...');
  await server.stop();
  await daemon.stop();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
