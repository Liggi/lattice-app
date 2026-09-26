/**
 * A Codex conversation keeps the reasoning effort it is running at across
 * every way its process can be replaced.
 *
 * The assertions are on what the app-server was actually asked for —
 * `thread/start`, `thread/resume` and `turn/start` — rather than on the
 * resolver, because the defect this covers was a route supplying its own
 * default to the provider while the resolver was never consulted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import express from 'express';
import request from 'supertest';
import { SessionManager } from '@liggi/agent-ui-harness/server';
import { admitTurn } from '../../src/services/sessions/turn-admission.js';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';
import { ActiveConversationRegistry } from '../../src/services/process/active-conversation-registry.js';
import { SqliteEventStorageAdapter } from '../../src/harness/sqlite-event-storage.js';
import { CodexProcessAdapter, type CodexAppServerLike } from '../../src/harness/codex-process-adapter.js';
import { createHarnessRoutes } from '../../src/harness/routes.js';
import { registerUnifiedConversationLifecycleRoutes } from '../../src/routes/conversation/unified-conversation.lifecycle-routes.js';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { CODEX_NOT_SIGNED_IN_MESSAGE } from '../../src/harness/codex-process-adapter.js';
import { enqueueInboxItem, markInboxItemsRead } from '../../src/services/sessions/session-inbox.js';
import type { CodexServerNotification, CodexThreadGoal, CodexTurn, CodexUserInput } from '../../src/services/process/codex-app-server-types.js';

/** The create route refuses a folder that does not exist. */
const PROJECT_DIR = os.tmpdir();

const holder = vi.hoisted(() => ({ manager: null as SessionManager | null }));
vi.mock('../../src/harness/setup.js', () => ({
  getHarnessSessionManager: () => holder.manager,
}));
vi.mock('../../src/services/infrastructure/config-service.js', () => ({
  ConfigService: {
    getInstance: () => ({
      // Immediate delivery off: these cases are about a message parked for the turn boundary.
      getConfig: () => ({ server: { host: '127.0.0.1', port: 3999, defaultPermissionMode: 'bypassPermissions' }, messaging: { immediateDelivery: false } }),
    }),
  },
}));

interface ThreadCall { cwd: string; model: string; reasoningEffort: string }

class FakeCodexClient extends EventEmitter implements CodexAppServerLike {
  startThreadCalls: ThreadCall[] = [];
  resumeThreadCalls: Array<{ threadId: string } & ThreadCall> = [];
  startTurnCalls: Array<{ threadId: string; model?: string; reasoningEffort: string }> = [];
  compactionCalls: string[] = [];
  private turnCounter = 0;
  activeTurnId: string | null = null;

  respondToServerRequest(): void {}
  respondToServerRequestError(): void {}
  async refreshChatGptAuth(): Promise<unknown> { return undefined; }

  async startThread(options: ThreadCall) {
    this.startThreadCalls.push(options);
    return { thread: { id: 'thread-1' }, model: options.model, cwd: options.cwd, reasoningEffort: options.reasoningEffort };
  }

  async resumeThread(threadId: string, options: ThreadCall) {
    this.resumeThreadCalls.push({ threadId, ...options });
    return { thread: { id: 'thread-1' }, model: options.model, cwd: options.cwd, reasoningEffort: options.reasoningEffort };
  }

  async startTurn(options: { threadId: string; input: CodexUserInput[]; model?: string; reasoningEffort: string }): Promise<{ turn: CodexTurn }> {
    this.startTurnCalls.push({ threadId: options.threadId, model: options.model, reasoningEffort: options.reasoningEffort });
    this.turnCounter += 1;
    const turn = { id: `turn-${this.turnCounter}` };
    this.activeTurnId = turn.id;
    this.emit('notification', { method: 'turn/started', params: { threadId: options.threadId, turn } } as CodexServerNotification);
    return { turn };
  }

  async startThreadCompaction(threadId: string): Promise<Record<string, never>> {
    this.compactionCalls.push(threadId);
    return {};
  }

  async interruptTurn(): Promise<void> {}

  async setGoal(): Promise<{ goal: CodexThreadGoal }> {
    throw new Error('not used');
  }

  /** End the turn the way the app-server does, so the session derives as idle. */
  finishTurn(): void {
    const turnId = this.activeTurnId;
    if (!turnId) return;
    this.activeTurnId = null;
    this.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed', durationMs: 1 } },
    } as CodexServerNotification);
  }

  /** The app-server going away, leaving the conversation with no process. */
  die(): void {
    this.activeTurnId = null;
    this.emit('exit', { code: 0, signal: null });
  }

  lastTurn(): { reasoningEffort: string } {
    return this.startTurnCalls[this.startTurnCalls.length - 1];
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

let client: FakeCodexClient;
let storage: SqliteEventStorageAdapter;
let registry: ActiveConversationRegistry;
let sessionInfoService: SessionInfoService;

/** A server lifetime: its own SessionManager over the shared event storage. */
function bootServer() {
  const adapter = new CodexProcessAdapter(
    () => {},
    () => client,
    undefined,
    ({ sessionId, reasoningEffort }) => {
      ConversationService.getInstance().updateLatestSegmentReasoningEffort(sessionId, reasoningEffort);
    },
  );
  const manager = new SessionManager(adapter, {
    storage,
    maxLogSize: 2000,
    // Stands in for event-side-effects.handleRunReady, which the real server
    // wires: without the thread id on the segment, a cold recovery could not
    // resume the thread at all and the effort question would not arise.
    onEvent: (event) => {
      if (event.type !== 'run:ready') return;
      const resumeId = (event.data as { resumeId?: string }).resumeId;
      if (resumeId) ConversationService.getInstance().updateSegmentProviderSessionId(event.sessionId, resumeId);
    },
  });
  holder.manager = manager;

  const app = express();
  app.use(express.json());
  app.use('/api/harness', createHarnessRoutes(manager, {
    resolveResumeSessionId: (conversationId) =>
      ConversationService.getInstance().getLatestSegment(conversationId)?.providerSessionId ?? conversationId,
    resolveProvider: () => 'codex',
    resolveWorkingDirectory: () => PROJECT_DIR,
  }));

  const conversationRouter = express.Router();
  registerUnifiedConversationLifecycleRoutes(conversationRouter, {
    activeConversationRegistry: registry,
    sessionInfoService,
    conversationService: ConversationService.getInstance(),
    generateTraceId: (prefix) => `${prefix}-trace`,
  });
  app.use('/api/conversations', conversationRouter);
  app.use(errorHandler);

  return { app, manager };
}

function storedEffort(conversationId: string): string | null {
  return ConversationService.getInstance().getLatestSegment(conversationId)?.reasoningEffort ?? null;
}

beforeEach(async () => {
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
  sessionInfoService = new SessionInfoService(':memory:');
  await sessionInfoService.initialize();
  const db = DatabaseProvider.getInstance().getDb();
  ConversationService.getInstance().initialize(db);
  storage = new SqliteEventStorageAdapter(db);
  registry = new ActiveConversationRegistry();
  client = new FakeCodexClient();
});

afterEach(() => {
  holder.manager = null;
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
});

/** The last launch configuration the harness would rebuild a spawn from. */
function rememberedLaunchEffort(conversationId: string): string | undefined {
  const starts = storage.read(conversationId, { beforeSeq: Number.MAX_SAFE_INTEGER, limit: 500 })
    .filter((event) => event.type === 'run:start');
  const data = starts.at(-1)?.data as { config?: { extra?: { reasoningEffort?: string } } } | undefined;
  return data?.config?.extra?.reasoningEffort;
}

/**
 * A coordinator created on medium and then moved to low while its process was
 * alive, with that process now gone. Nothing re-recorded the launch
 * configuration, so the harness still remembers medium — the state in which
 * every replacement path used to restore the older setting.
 */
async function coordinatorMovedToLow(): Promise<string> {
  const { app } = bootServer();
  const created = await request(app).post('/api/conversations/create').send({
    provider: 'codex',
    message: 'take the work',
    workingDirectory: PROJECT_DIR,
    coordinator: true,
  });
  expect(created.status).toBe(200);
  const conversationId = created.body.conversationId as string;
  await settle();

  client.finishTurn();
  await settle();
  expect((await request(app).post(`/api/harness/${conversationId}/send`)
    .send({ input: 'go faster', reasoningEffort: 'low' })).status).toBe(200);
  await settle();
  client.finishTurn();
  await settle();
  client.die();
  await settle();

  expect(rememberedLaunchEffort(conversationId)).toBe('medium');
  expect(storedEffort(conversationId)).toBe('low');
  return conversationId;
}

describe('a Codex conversation records the effort it is running at', () => {
  it('starts a coordinator nobody pinned on the coordinator default', async () => {
    const { app } = bootServer();

    const created = await request(app).post('/api/conversations/create').send({
      provider: 'codex',
      message: 'take the work',
      workingDirectory: PROJECT_DIR,
      coordinator: true,
    });

    expect(created.status).toBe(200);
    await settle();
    expect(client.startThreadCalls[0]).toMatchObject({ reasoningEffort: 'medium' });
    expect(client.lastTurn()).toMatchObject({ reasoningEffort: 'medium' });
    expect(storedEffort(created.body.conversationId)).toBe('medium');
  });

  it('records an explicit change, and keeps it for a send that names no effort', async () => {
    const { app } = bootServer();
    const created = await request(app).post('/api/conversations/create').send({
      provider: 'codex',
      message: 'take the work',
      workingDirectory: PROJECT_DIR,
      coordinator: true,
    });
    const conversationId = created.body.conversationId as string;
    await settle();
    client.finishTurn();
    await settle();

    await request(app).post(`/api/harness/${conversationId}/send`).send({ input: 'go faster', reasoningEffort: 'low' });
    await settle();
    expect(client.lastTurn()).toMatchObject({ reasoningEffort: 'low' });
    expect(storedEffort(conversationId)).toBe('low');

    client.finishTurn();
    await settle();
    await request(app).post(`/api/harness/${conversationId}/send`).send({ input: 'carry on' });
    await settle();
    expect(client.lastTurn()).toMatchObject({ reasoningEffort: 'low' });
  });
});

describe('every way the process can be replaced keeps that setting', () => {
  it('respawns a dead process on it rather than on the one it launched with', async () => {
    const conversationId = await coordinatorMovedToLow();
    const { app } = bootServer();
    holder.manager!.recoverFromStorage(conversationId);

    expect((await request(app).post(`/api/harness/${conversationId}/send`)
      .send({ input: 'after the process died' })).status).toBe(200);
    await settle();

    expect(client.resumeThreadCalls.at(-1)).toMatchObject({ reasoningEffort: 'low' });
    expect(client.lastTurn()).toMatchObject({ reasoningEffort: 'low' });
  });

  it('recovers a server that has never seen the session on it', async () => {
    const conversationId = await coordinatorMovedToLow();
    const { app } = bootServer();

    expect((await request(app).post(`/api/harness/${conversationId}/send`)
      .send({ input: 'after the server restarted' })).status).toBe(200);
    await settle();

    expect(client.resumeThreadCalls.at(-1)).toMatchObject({ reasoningEffort: 'low' });
    expect(client.lastTurn()).toMatchObject({ reasoningEffort: 'low' });
  });

  it('recovers a session whose launch config a long turn buried on it', async () => {
    const conversationId = await coordinatorMovedToLow();
    const buried = bootServer();
    const log = buried.manager.getLog(conversationId) ?? buried.manager.recoverFromStorage(conversationId)!;
    for (let i = 0; i < 60; i++) {
      log.append('content', { blocks: [{ type: 'text', text: `line ${i}` }] }, 'run-buried', conversationId);
    }

    const { app, manager } = bootServer();
    // The harness searches only the recent tail for the launch configuration,
    // so this recovery has none at all: the send fails over to a cold start.
    manager.recoverFromStorage(conversationId);
    expect((await request(app).post(`/api/harness/${conversationId}/send`)
      .send({ input: 'after a long history' })).status).toBe(200);
    await settle();

    expect(client.resumeThreadCalls.at(-1)).toMatchObject({ reasoningEffort: 'low' });
    expect(client.lastTurn()).toMatchObject({ reasoningEffort: 'low' });
  });

  it('compacts a conversation with no live process on it', async () => {
    const conversationId = await coordinatorMovedToLow();
    const { app } = bootServer();

    expect((await request(app).post(`/api/harness/${conversationId}/compact`).send({})).status).toBe(200);
    await settle();

    expect(client.resumeThreadCalls.at(-1)).toMatchObject({ reasoningEffort: 'low' });
    expect(client.compactionCalls.at(-1)).toBe('thread-1');
    expect(storedEffort(conversationId)).toBe('low');
  });
});

/**
 * Inbox rows are the only legacy evidence the resolver has, and they are
 * written the moment a message is parked — before anything is applied. A
 * recovery in that window must take the last effort the conversation was
 * actually given, not the one a message it has not read yet asks for.
 */
describe('a parked message is not evidence of what the conversation is running at', () => {
  /**
   * A conversation from before the column: delivered on high, with a later
   * message waiting at low that no turn has taken.
   */
  async function legacyOnHighWithParkedLow(): Promise<string> {
    const { app } = bootServer();
    const created = await request(app).post('/api/conversations/create').send({
      provider: 'codex',
      message: 'take the work',
      workingDirectory: PROJECT_DIR,
      coordinator: true,
    });
    const conversationId = created.body.conversationId as string;
    await settle();
    client.finishTurn();
    await settle();

    // Delivered: the drain's send, then the read that follows it.
    const delivered = enqueueInboxItem({
      sessionId: conversationId, source: 'user', text: 'think harder', reasoningEffort: 'high',
    });
    // The drain is the only caller allowed to send an `inboxIds` batch, and it
    // proves it by passing the turn admission it already holds
    // (turn-admission.ts). Standing in for the drain here means holding one too.
    const drainAdmission = await admitTurn(conversationId, 'drain');
    try {
      expect((await request(app).post(`/api/harness/${conversationId}/send`)
        .send({ input: 'think harder', inboxIds: [delivered], reasoningEffort: 'high', admission: drainAdmission.id })).status).toBe(200);
    } finally {
      drainAdmission.release();
    }
    await settle();
    markInboxItemsRead([delivered]);

    // Pre-migration: the segment never recorded a setting.
    DatabaseProvider.getInstance().getDb()
      .prepare('UPDATE conversation_segments SET reasoning_effort = NULL WHERE conversation_id = ?')
      .run(conversationId);

    // Parked mid-turn, so it never reaches the process.
    const parked = await request(app).post(`/api/harness/${conversationId}/send`)
      .send({ input: 'go faster', reasoningEffort: 'low' });
    expect(parked.body.delivery).toBe('after-turn');

    client.finishTurn();
    await settle();
    client.die();
    await settle();
    return conversationId;
  }

  it('compacts on the delivered setting, not the one still waiting', async () => {
    const conversationId = await legacyOnHighWithParkedLow();
    const { app } = bootServer();

    expect((await request(app).post(`/api/harness/${conversationId}/compact`).send({})).status).toBe(200);
    await settle();

    expect(client.resumeThreadCalls.at(-1)).toMatchObject({ reasoningEffort: 'high' });
    expect(storedEffort(conversationId)).toBe('high');
  });

  it('starts on the delivered setting, not the one still waiting', async () => {
    const conversationId = await legacyOnHighWithParkedLow();
    const { app } = bootServer();

    expect((await request(app).post(`/api/harness/${conversationId}/start`)
      .send({ prompt: 'picked the thread back up' })).status).toBe(200);
    await settle();

    expect(client.resumeThreadCalls.at(-1)).toMatchObject({ reasoningEffort: 'high' });
    expect(client.lastTurn()).toMatchObject({ reasoningEffort: 'high' });
  });

  // A send cannot reach the provider while a row is waiting — it joins the
  // queue behind it — so the parked setting has no route in through /send.
  it('queues a later send behind the waiting message rather than overtaking it', async () => {
    const conversationId = await legacyOnHighWithParkedLow();
    const { app } = bootServer();

    const queued = await request(app).post(`/api/harness/${conversationId}/send`)
      .send({ input: 'something else entirely' });
    expect(queued.body.delivery).toBe('after-turn');
    expect(client.resumeThreadCalls).toHaveLength(0);
  });
});

describe('a create whose session cannot start', () => {
  it('answers with the reason and leaves no project in the sidebar', async () => {
    client.refreshChatGptAuth = async () => ({ account: null, requiresOpenaiAuth: true });
    const { app } = bootServer();

    const created = await request(app).post('/api/conversations/create').send({
      provider: 'codex',
      message: 'take the work',
      workingDirectory: PROJECT_DIR,
      coordinator: true,
    });

    expect(created.status).toBe(400);
    expect(JSON.stringify(created.body)).toContain(CODEX_NOT_SIGNED_IN_MESSAGE);
    const conversations = ConversationService.getInstance();
    expect(conversations.listConversations({ archived: false }).total).toBe(0);
    expect(conversations.listConversations().total).toBe(1);
  });
});
