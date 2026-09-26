/**
 * The durable half of a persistent project session: a record that separates
 * what is currently true from what once was, and one projection of it that
 * reaches every turn.
 *
 * Three things a long-running project needs that an append-only list of
 * decisions could not give it. A correction has to be able to take the
 * instruction it replaces out of force, by seq rather than by contradicting
 * it in prose — front's own record folded to 58 decisions holding both a rule
 * and its reversal. The work the project is on has to survive the turn that
 * chose it, which `now` does not. And a thread has to carry what it has
 * established, because "built, tested, not integrated" was only ever
 * inferable from the next action.
 *
 * The projection is the other half: the same text on an ordinary message, on
 * a worker's report, after a compaction and on a cold resume, and not sent
 * again while the session already has it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { RawEvent } from '../../src/session-history/types.js';

let storedEvents = new Map<string, RawEvent[]>();
let nextSeq = 1000;

vi.mock('../../src/harness/setup.js', () => ({
  getHarnessSessionManager: () => ({ inspect: () => null }),
}));
vi.mock('../../src/harness/harness-custom-events.js', () => ({
  appendCustomHarnessEvent: (_manager: unknown, sessionId: string, type: string, data: unknown) => {
    nextSeq += 1;
    const event = { conversationId: sessionId, seq: nextSeq, runId: 'run-1', timestamp: nextSeq, type, data, meta: null } as RawEvent;
    storedEvents.set(sessionId, [...(storedEvents.get(sessionId) ?? []), event]);
    return { seq: nextSeq, type, data };
  },
}));
vi.mock('../../src/session-history/repository.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEvents: (conversationId: string) => storedEvents.get(conversationId) ?? [],
}));

const { DatabaseProvider } = await import('../../src/services/infrastructure/database-provider.js');
const { ConversationService } = await import('../../src/services/sessions/conversation-service.js');
const { SessionInfoService } = await import('../../src/services/sessions/session-info-service.js');
const { createUnifiedConversationRoutes } = await import('../../src/routes/conversation/unified-conversation.routes.js');
const { buildProjectOrientation, PROJECT_ORIENTED_EVENT } = await import('../../src/services/sessions/project-orientation.js');
const { readProjectState } = await import('../../src/services/sessions/project-state.js');
const { renderProjectState } = await import('../../src/types/project-state.js');
const { stripContextRestore } = await import('../../src/types/worker-events.js');
const { parseVerbArgs, SESSION_VERBS_BY_NAME } = await import('../../src/cli/session-cli-spec.js');
type ProjectState = import('../../src/types/project-state.js').ProjectState;

function app(): express.Express {
  const application = express();
  application.use(express.json());
  application.use('/api/conv', createUnifiedConversationRoutes({
    historyReader: {} as never,
    activeConversationRegistry: { get: () => undefined } as never,
    sessionInfoService: new SessionInfoService(':memory:'),
    permissionTracker: {} as never,
  }));
  return application;
}

/** The spec for one verb; the parser validates against the same table help is built from. */
function verb(name: string) {
  const spec = SESSION_VERBS_BY_NAME.get(name);
  if (!spec) throw new Error(`no such verb: ${name}`);
  return spec;
}

function push(conversationId: string, type: string, data: unknown): number {
  nextSeq += 1;
  const event = { conversationId, seq: nextSeq, runId: 'run-1', timestamp: nextSeq, type, data, meta: null } as RawEvent;
  storedEvents.set(conversationId, [...(storedEvents.get(conversationId) ?? []), event]);
  return nextSeq;
}

let coordinator: string;
let worker: string;
let server: express.Express;

/** One note through the route, which is the only way a note is ever written. */
async function note(body: Record<string, unknown>): Promise<{ status: number; seq: number; state: ProjectState; error?: string }> {
  const res = await request(server).post(`/api/conv/${coordinator}/project/note`).send(body);
  return { status: res.status, seq: res.body.seq, state: res.body.state, error: res.body.error };
}

beforeEach(async () => {
  storedEvents = new Map();
  nextSeq = 1000;
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
  await new SessionInfoService(':memory:').initialize();
  const service = ConversationService.getInstance();
  coordinator = service.createConversation({ workingDirectory: '/tmp', provider: 'codex', providerSessionId: 'p-front', coordinator: true }).conversationId;
  worker = service.createConversation({ workingDirectory: '/tmp', provider: 'claude', providerSessionId: 'p-w', pickedUpFrom: coordinator }).conversationId;
  server = app();
});
afterEach(() => {
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
});

describe('a decision and the correction that replaces it', () => {
  it('takes the old one out of force, keeps it, and says what replaced it', async () => {
    const first = await note({ kind: 'decision', text: 'the session does the work itself' });
    const second = await note({
      kind: 'decision',
      text: 'the session delegates execution and integrates the result',
      by: 'user',
      supersedes: [first.seq],
    });

    expect(second.state.decisions.map((decision) => decision.text))
      .toEqual(['the session delegates execution and integrates the result']);
    expect(second.state.retired).toEqual([expect.objectContaining({
      seq: first.seq,
      text: 'the session does the work itself',
      retiredBy: second.seq,
      reason: 'the session delegates execution and integrates the result',
    })]);

    // Nothing is deleted: the original and what replaced it are both there,
    // and only the explicit history view prints them.
    const active = renderProjectState(second.state);
    expect(active).not.toContain('does the work itself');
    expect(active).toContain('1 decision no longer in force');
    const history = renderProjectState(second.state, { history: true });
    expect(history).toContain('does the work itself');
    expect(history).toContain(`[${second.seq}] the session delegates execution`);
  });

  it('withdraws one with nothing in its place, and needs a reason to do it', async () => {
    const paused = await note({ kind: 'decision', text: 'pause every worker on this project' });
    expect((await note({ kind: 'retire', text: 'The user lifted it', supersedes: [] })).status).toBe(400);
    expect((await note({ kind: 'retire', text: '' })).status).toBe(400);

    const retired = await note({ kind: 'retire', text: 'The user lifted the pause', supersedes: [paused.seq] });
    expect(retired.status).toBe(200);
    expect(retired.state.decisions).toEqual([]);
    expect(retired.state.retired[0]).toMatchObject({ seq: paused.seq, reason: 'The user lifted the pause' });
  });

  it('refuses a seq that is not a decision in force, and says what happened to one already out', async () => {
    const first = await note({ kind: 'decision', text: 'ship without the canary' });
    await note({ kind: 'decision', text: 'ship with the canary', supersedes: [first.seq] });

    const unknown = await note({ kind: 'retire', text: 'no', supersedes: [999] });
    expect(unknown.status).toBe(400);
    expect(unknown.error).toContain('not a decision in force');

    const again = await note({ kind: 'retire', text: 'no', supersedes: [first.seq] });
    expect(again.status).toBe(400);
    expect(again.error).toContain('already stopped binding');
  });
});

describe('the priority', () => {
  it('outlives the turn that set it, where `now` does not', async () => {
    await note({ kind: 'now', text: 'reading the report' });
    await note({ kind: 'priority', text: 'finish unread-message visibility' });
    push(coordinator, 'turn:end', {});

    const state = readProjectState(coordinator);
    expect(state.now).toBeNull();
    expect(state.priority?.text).toBe('finish unread-message visibility');
    expect(renderProjectState(state)).toContain('Priority: finish unread-message visibility');
  });

  it('is replaced by the next one, and cleared by closing the thread it named', async () => {
    const thread = await note({ kind: 'open', text: 'show unread messages' });
    const other = await note({ kind: 'open', text: 'truthful worker status' });

    await note({ kind: 'priority', text: 'first this', ref: thread.seq });
    const moved = await note({ kind: 'priority', text: 'then that', ref: other.seq });
    expect(moved.state.priority).toMatchObject({ text: 'then that', thread: other.seq });

    // Closing a thread the priority does not name leaves it alone.
    const unrelated = await note({ kind: 'close', text: 'done', ref: thread.seq });
    expect(unrelated.state.priority?.text).toBe('then that');

    const closed = await note({ kind: 'close', text: 'verified live', ref: other.seq });
    expect(closed.state.priority).toBeNull();
  });

  it('may name only an open thread of this project', async () => {
    const refused = await note({ kind: 'priority', text: 'work on it', ref: 999 });
    expect(refused.status).toBe(400);
    expect(refused.error).toContain('open thread');

    const free = await note({ kind: 'priority', text: 'work on it' });
    expect(free.status).toBe(200);
    expect(free.state.priority).toMatchObject({ text: 'work on it', thread: null });
  });
});

describe("a thread's own account of itself", () => {
  it('keeps what the work has established separately from what the work is for', async () => {
    const thread = await note({ kind: 'open', text: 'show unread messages' });
    const updated = await note({
      kind: 'update',
      ref: thread.seq,
      text: 'built and tested on a branch, not integrated and not live',
      nextAction: 'integrate it and check a real queued message',
      evidence: ['restyle-unread-visibility @ d922ac64'],
    });

    const open = updated.state.open[0];
    expect(open.text).toBe('show unread messages');
    expect(open.summary).toBe('built and tested on a branch, not integrated and not live');
    expect(open.evidence).toEqual(['restyle-unread-visibility @ d922ac64']);

    const rendered = renderProjectState(updated.state);
    expect(rendered).toContain('so far: built and tested on a branch, not integrated and not live');
    expect(rendered).toContain('evidence: restyle-unread-visibility @ d922ac64');
  });

  it('replaces the summary as the work moves and adds evidence without repeating it', async () => {
    const thread = await note({ kind: 'open', text: 'show unread messages' });
    await note({ kind: 'update', ref: thread.seq, text: 'built, not integrated', evidence: ['branch d922ac64'] });
    await note({ kind: 'update', ref: thread.seq, text: 'built, not integrated', evidence: ['branch d922ac64'] });
    const live = await note({ kind: 'update', ref: thread.seq, text: 'live and checked on a real queued message', evidence: ['report 9555'] });

    expect(live.state.open[0].summary).toBe('live and checked on a real queued message');
    expect(live.state.open[0].evidence).toEqual(['branch d922ac64', 'report 9555']);
  });

  it('still refuses an update that changes nothing, and accepts one carrying only evidence', async () => {
    const thread = await note({ kind: 'open', text: 'show unread messages' });
    expect((await note({ kind: 'update', ref: thread.seq })).status).toBe(400);
    expect((await note({ kind: 'update', ref: thread.seq, evidence: ['report 9555'] })).status).toBe(200);
  });
});

describe('orientation on a project turn', () => {
  const orient = (): string => buildProjectOrientation(coordinator, 'lattice');

  beforeEach(async () => {
    await note({ kind: 'outcome', text: 'one durable project session' });
  });

  it('is the active projection, word for word, and is stripped before the user sees the message', () => {
    const block = orient();
    expect(block).toContain(renderProjectState(readProjectState(coordinator), { cli: 'lattice', conversationId: coordinator }));
    expect(stripContextRestore(`${block}what shall we do next?`)).toBe('what shall we do next?');
  });

  it('is not sent again while the session already has it', () => {
    expect(orient()).not.toBe('');
    expect(orient()).toBe('');
  });

  it('comes back as soon as the record moves — which is what a worker report does', async () => {
    orient();
    expect(orient()).toBe('');
    // A report is a worker event, so it advances the revision; the turn that
    // reads it is oriented by the state that now includes it.
    push(coordinator, 'worker:reported', { worker, model: null, text: 'Done and verified.' });
    expect(orient()).not.toBe('');
  });

  it('comes back after a compaction even though nothing in the record changed', () => {
    orient();
    expect(orient()).toBe('');
    push(coordinator, 'turn:end', { compact: true });
    const block = orient();
    expect(block).toContain('context was just compacted');
    expect(block).toContain('one durable project session');
  });

  it('records the revision it showed, on an event inert to the record itself', () => {
    const before = readProjectState(coordinator).revision;
    orient();
    const oriented = (storedEvents.get(coordinator) ?? []).filter((event) => event.type === PROJECT_ORIENTED_EVENT);
    expect(oriented).toHaveLength(1);
    expect((oriented[0].data as { revision: number }).revision).toBe(before);
    // Writing it must not make itself due again.
    expect(readProjectState(coordinator).revision).toBe(before);
  });

  it('is for project sessions with something noted, and nobody else', () => {
    expect(buildProjectOrientation(worker, 'lattice')).toBe('');
    const fresh = ConversationService.getInstance().createConversation({
      workingDirectory: '/tmp', provider: 'codex', providerSessionId: 'p-2', coordinator: true,
    }).conversationId;
    expect(buildProjectOrientation(fresh, 'lattice')).toBe('');
  });
});

describe('the flags that write and read this', () => {
  it('takes a correction, a retirement, a priority, a summary and evidence', () => {
    const parsed = parseVerbArgs(verb('note'), [
      coordinator, '--priority', 'finish unread-message visibility', '--thread', '31906',
      '--summary', 'built, not integrated', '--evidence', 'branch d922ac64',
    ]);
    expect(parsed.flags.priority).toBe('finish unread-message visibility');
    expect(parsed.flags.summary).toBe('built, not integrated');
    expect(parsed.flags.evidence).toBe('branch d922ac64');

    expect(parseVerbArgs(verb('note'), [coordinator, '--decide', 'x', '--replaces', '412,415']).flags.replaces).toBe('412,415');
    expect(parseVerbArgs(verb('note'), [coordinator, '--retire', '412', '--with', 'why']).flags.retire).toBe('412');
  });

  it('reads history only when asked, and can dispatch Astra at the effort the work needs', () => {
    expect(parseVerbArgs(verb('state'), [coordinator, '--history']).flags.history).toBe(true);
    expect(parseVerbArgs(verb('state'), [coordinator]).flags.history).toBeUndefined();
    const dispatch = parseVerbArgs(verb('new'), [
      '--from', coordinator, '--provider', 'codex', '--model', 'gpt-6-astra', '--reasoning-effort', 'xhigh', '--prompt', 'think',
    ]);
    expect(dispatch.flags['reasoning-effort']).toBe('xhigh');
  });
});
