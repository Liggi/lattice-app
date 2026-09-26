/**
 * Delivering a message into the turn a session is already running.
 *
 * The cases here are the ones where getting it wrong shows up as a message
 * the model never saw, or one it saw twice: what goes in the batch, what a
 * turn ending mid-handover does, and the difference between a provider that
 * refused and one that never answered.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionManager, SteerOutcome, SteerRequest, SteerStage } from '@liggi/agent-ui-harness/server';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';
import { __resetTurnAdmissionForTests, admitTurn } from '../../src/services/sessions/turn-admission.js';

const appended: Array<{ type: string; data: Record<string, unknown> }> = [];
let nextSeq = 100;

vi.mock('../../src/harness/setup.js', () => ({
  getHarnessSessionManager: () => null,
}));
vi.mock('../../src/services/infrastructure/config-service.js', () => ({
  ConfigService: { getInstance: () => ({ getConfig: () => ({ server: { host: '0.0.0.0', port: 3999 } }) }) },
}));
vi.mock('../../src/harness/harness-custom-events.js', () => ({
  appendCustomHarnessEvent: (_m: unknown, _s: string, type: string, data: unknown) => {
    nextSeq += 1;
    appended.push({ type, data: data as Record<string, unknown> });
    return { seq: nextSeq, type, data };
  },
}));

const inbox = await import('../../src/services/sessions/session-inbox.js');
const { deliverIntoRunningTurn } = await import('../../src/services/sessions/immediate-delivery.js');

/**
 * A session manager whose `steer` is whatever the test needs. `stages` is the
 * script of what the provider reports and when: entries before the outcome
 * fire during the call, the rest are replayed later by `emitLate`.
 */
function manager(options: {
  outcome: SteerOutcome;
  duringCall?: SteerStage[];
  sentSeq?: number;
}): { manager: SessionManager; emitLate: (stage: SteerStage) => void; input: () => string } {
  let captured: SteerRequest | null = null;
  const steer = vi.fn(async (_sessionId: string, request: SteerRequest): Promise<SteerOutcome> => {
    captured = request;
    for (const stage of options.duringCall ?? []) request.onStage?.(stage);
    return options.outcome.status === 'accepted' && options.sentSeq !== undefined
      ? { ...options.outcome, sentSeq: options.sentSeq }
      : options.outcome;
  });
  return {
    manager: { steer } as unknown as SessionManager,
    emitLate: (stage) => captured?.onStage?.(stage),
    input: () => captured?.input ?? '',
  };
}

const HANDED: SteerStage = { kind: 'handed-over' };
const ACCEPTED: SteerStage = { kind: 'accepted', late: false };
const INCORPORATED: SteerStage = { kind: 'incorporated', where: 'mid-turn', evidence: 'started before result' };

async function deliver(sessionManager: SessionManager, sessionId: string, inboxId: string) {
  const admission = await admitTurn(sessionId, 'send');
  try {
    return await deliverIntoRunningTurn({ sessionManager, sessionId, admission, inboxId });
  } finally {
    admission.release();
  }
}

const events = (type: string) => appended.filter((event) => event.type === type);

beforeEach(async () => {
  DatabaseProvider.resetInstance();
  await new SessionInfoService(':memory:').initialize();
  appended.length = 0;
  __resetTurnAdmissionForTests();
});
afterEach(() => {
  DatabaseProvider.resetInstance();
});

describe('what goes into the batch', () => {
  it('sends every ready row oldest first, with each one still labelled as its own', async () => {
    inbox.enqueueInboxItem({
      sessionId: 'conv-c', source: 'worker-report', text: 'the migration is applied', worker: 'conv-w',
    });
    inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'agent', text: 'heads up', sender: 'conv-other' });
    const latest = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'use PEACH' });

    const fake = manager({ outcome: { status: 'accepted' }, duringCall: [HANDED, ACCEPTED] });
    const result = await deliver(fake.manager, 'conv-c', latest);

    expect(result).toMatchObject({ status: 'delivered', items: 3 });
    const sent = fake.input();
    expect(sent.indexOf('the migration is applied')).toBeLessThan(sent.indexOf('heads up'));
    expect(sent.indexOf('heads up')).toBeLessThan(sent.indexOf('use PEACH'));
    // Provenance survives the route: the report is still a report and the
    // other conversation's message is still attributed to it.
    expect(sent).toContain('conv-w');
    expect(sent).toContain('conv-other');
    // And the model is told this arrived mid-turn rather than as a new turn.
    expect(sent).toContain('delivered into the turn you are running');
  });

  it('leaves an exchange held for a quick answer where it is, unsent and unchanged', async () => {
    const waiting = inbox.enqueueInboxItem({
      sessionId: 'conv-c', source: 'user', text: 'what is the status?', replyPending: true,
    });
    const latest = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'use PEACH' });

    const fake = manager({ outcome: { status: 'accepted' }, duringCall: [HANDED, ACCEPTED] });
    const result = await deliver(fake.manager, 'conv-c', latest);

    expect(result).toMatchObject({ status: 'delivered', items: 1 });
    expect(fake.input()).not.toContain('what is the status?');
    expect(inbox.getInboxItem(waiting)).toMatchObject({ read_at: null, reply_pending: 1, reserved_by: null });
  });

  it('says a message arrived during a compaction, and who sent it, rather than describing a running tool call', async () => {
    // The provider holds it until the compaction ends and shows it inside the
    // compaction's output; the running-turn note there read as an injection.
    const db = DatabaseProvider.getInstance().getDb();
    const event = db.prepare(
      `INSERT INTO harness_events (session_id, seq, run_id, timestamp, type, data) VALUES ('conv-c', ?, 'run-1', ?, ?, ?)`,
    );
    event.run(1, '2026-09-23T21:00:00Z', 'turn:end', '{}');
    event.run(2, '2026-09-23T21:01:00Z', 'context:compaction', JSON.stringify({ phase: 'started' }));
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'agent', text: 'heads up', sender: 'conv-other' });

    const fake = manager({ outcome: { status: 'accepted' }, duringCall: [HANDED, ACCEPTED] });
    await deliver(fake.manager, 'conv-c', id);

    expect(fake.input()).toContain('This message arrived while this session was compacting its context; it is from conv-other.');
    expect(fake.input()).not.toContain('tool call');

    // Once the compaction has finished, a message is back to being one that arrived mid-turn.
    event.run(3, '2026-09-23T21:02:00Z', 'context:compaction', JSON.stringify({ phase: 'completed' }));
    const later = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'use PEACH' });
    const next = manager({ outcome: { status: 'accepted' }, duringCall: [HANDED, ACCEPTED] });
    await deliver(next.manager, 'conv-c', later);
    expect(next.input()).toContain('delivered into the turn you are running');
  });

  it('refuses when the row has already been taken by another delivery', async () => {
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'use PEACH' });
    inbox.markInboxItemsRead([id], 7);

    const fake = manager({ outcome: { status: 'accepted' } });
    expect(await deliver(fake.manager, 'conv-c', id)).toMatchObject({ status: 'rejected', items: 0 });
  });
});

describe('acceptance is not incorporation', () => {
  it('does not say a turn read the batch until the provider says a turn took it', async () => {
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'use PEACH' });
    const fake = manager({ outcome: { status: 'accepted' }, duringCall: [HANDED, ACCEPTED], sentSeq: 42 });

    const result = await deliver(fake.manager, 'conv-c', id);

    expect(result.status).toBe('delivered');
    // Acknowledged, so the sender has a receipt — but no turn has been given
    // it, so the thread must not show it as read and the row must not be
    // available to a drain either.
    expect(events('input:read')).toHaveLength(0);
    expect(inbox.getInboxItem(id)).toMatchObject({ read_at: null, reservation_state: 'accepted' });
    expect(inbox.unreadInboxItems('conv-c')).toHaveLength(0);

    fake.emitLate(INCORPORATED);

    expect(events('input:read')[0]?.data).toMatchObject({ ids: [id], sentSeq: 42 });
    expect(events('input:incorporated')[0]?.data).toMatchObject({ where: 'mid-turn' });
    expect(inbox.getInboxItem(id)?.read_at).not.toBeNull();
    expect(inbox.getInboxItem(id)?.reserved_by).toBeNull();
  });

  it('records a next-turn incorporation as such rather than as mid-turn', async () => {
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'use PEACH' });
    const fake = manager({ outcome: { status: 'accepted' }, duringCall: [HANDED, ACCEPTED] });
    await deliver(fake.manager, 'conv-c', id);

    fake.emitLate({ kind: 'incorporated', where: 'next-turn', evidence: 'started after result' });

    expect(events('input:incorporated')[0]?.data).toMatchObject({ where: 'next-turn' });
  });

  it('still pairs the receipt when the provider incorporates inside the call, as Codex does', async () => {
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'use PEACH' });
    // Codex answers `turn/steer` having already merged the input, so all
    // three stages fire before the harness has said which send carried it.
    const fake = manager({
      outcome: { status: 'accepted' },
      duringCall: [HANDED, ACCEPTED, INCORPORATED],
      sentSeq: 77,
    });

    const result = await deliver(fake.manager, 'conv-c', id);

    expect(result.status).toBe('delivered');
    expect(events('input:read')[0]?.data).toMatchObject({ ids: [id], sentSeq: 77 });
    expect(inbox.getInboxItem(id)?.read_at).not.toBeNull();
  });
});

describe('when the delivery does not land', () => {
  it('puts a refused batch back in the inbox, unread and unreserved', async () => {
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'use PEACH' });
    const fake = manager({ outcome: { status: 'rejected', reason: 'no running turn' }, duringCall: [HANDED] });

    const result = await deliver(fake.manager, 'conv-c', id);

    expect(result).toMatchObject({ status: 'rejected', reason: 'no running turn' });
    expect(inbox.unreadInboxItems('conv-c').map((r) => r.id)).toEqual([id]);
    expect(inbox.getInboxItem(id)).toMatchObject({ read_at: null, reserved_by: null, reservation_state: null });
    expect(events('input:read')).toHaveLength(0);
  });

  it('holds an unacknowledged batch rather than re-sending it or claiming it arrived', async () => {
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'use PEACH' });
    const fake = manager({ outcome: { status: 'uncertain', reason: 'no acknowledgement' }, duringCall: [HANDED] });

    const result = await deliver(fake.manager, 'conv-c', id);

    expect(result.status).toBe('uncertain');
    expect(inbox.getInboxItem(id)).toMatchObject({ read_at: null, reservation_state: 'uncertain' });
    // Neither of the confident answers: not readable by a drain, not read.
    expect(inbox.unreadInboxItems('conv-c')).toHaveLength(0);
    expect(events('input:read')).toHaveLength(0);
    expect(inbox.uncertainInboxReservations('conv-c').map((r) => r.id)).toEqual([id]);
  });

  it('reconciles a held batch when the acknowledgement turns up after the wait gave up', async () => {
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'use PEACH' });
    const fake = manager({ outcome: { status: 'uncertain', reason: 'no acknowledgement' }, duringCall: [HANDED] });
    await deliver(fake.manager, 'conv-c', id);
    expect(inbox.getInboxItem(id)?.reservation_state).toBe('uncertain');

    fake.emitLate({ kind: 'accepted', late: true });
    // The send is only recorded now, because until now nothing witnessed it.
    const sent = appended.filter((event) => event.type === 'input:sent');
    expect(sent).toHaveLength(1);
    expect(inbox.getInboxItem(id)?.reservation_state).toBe('accepted');

    fake.emitLate(INCORPORATED);
    expect(events('input:incorporated')[0]?.data).toMatchObject({ late: true });
    expect(inbox.getInboxItem(id)?.read_at).not.toBeNull();
  });

  it('does not call an ordinary Claude incorporation late just because it came after the call', async () => {
    // Claude acknowledges in milliseconds and the turn takes the message
    // whenever it next reads input, which is normal and not a late
    // acknowledgement: nothing was ever reported as unacknowledged.
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'use PEACH' });
    const fake = manager({ outcome: { status: 'accepted' }, duringCall: [HANDED, ACCEPTED], sentSeq: 12 });

    const result = await deliver(fake.manager, 'conv-c', id);
    expect(result.status).toBe('delivered');

    fake.emitLate(INCORPORATED);
    expect(events('input:incorporated')[0]?.data).not.toHaveProperty('late');
    expect(events('input:read')[0]?.data).toMatchObject({ sentSeq: 12 });
  });
});

describe('a turn ending underneath the delivery', () => {
  it('leaves a drain that fires mid-handover nothing to send', async () => {
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'use PEACH' });
    let duringHandover: string[] = [];
    const steer = vi.fn(async (_s: string, request: SteerRequest): Promise<SteerOutcome> => {
      request.onStage?.(HANDED);
      // The turn ends here and its drain looks for work.
      duringHandover = inbox.unreadInboxItems('conv-c').map((r) => r.id);
      request.onStage?.(ACCEPTED);
      return { status: 'accepted' };
    });

    await deliver({ steer } as unknown as SessionManager, 'conv-c', id);

    expect(duringHandover).toEqual([]);
  });

  it('holds the inbox back while a delivery is unresolved, and releases it on incorporation', async () => {
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'use PEACH' });
    const fake = manager({ outcome: { status: 'accepted' }, duringCall: [HANDED, ACCEPTED] });
    await deliver(fake.manager, 'conv-c', id);

    // A message arriving in the gap between acceptance and incorporation: the
    // provider still has input of ours queued, so a second send would race it.
    inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'and use PLUM' });
    expect(inbox.sessionHasDeliveryInFlight('conv-c', 120_000)).toBe(true);

    fake.emitLate(INCORPORATED);
    expect(inbox.sessionHasDeliveryInFlight('conv-c', 120_000)).toBe(false);
  });

  it('stops holding the inbox once a delivery is older than the grace', async () => {
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'use PEACH' });
    const fake = manager({ outcome: { status: 'accepted' }, duringCall: [HANDED, ACCEPTED] });
    await deliver(fake.manager, 'conv-c', id);

    expect(inbox.sessionHasDeliveryInFlight('conv-c', 0)).toBe(false);
  });
});

describe('what a restart may assume', () => {
  it('frees a batch the previous run had reserved but never handed over', async () => {
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'use PEACH' });
    inbox.reserveInboxItems([id], 'res-1');

    expect(inbox.resolveReservationsAtStartup()).toEqual({ released: 1, unresolved: 0 });
    expect(inbox.unreadInboxItems('conv-c').map((r) => r.id)).toEqual([id]);
  });

  it('holds a batch the previous run had handed over, because it may already have arrived', async () => {
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'use PEACH' });
    inbox.reserveInboxItems([id], 'res-1');
    inbox.markInboxReservation('res-1', 'handed');

    expect(inbox.resolveReservationsAtStartup()).toEqual({ released: 0, unresolved: 1 });
    expect(inbox.getInboxItem(id)?.reservation_state).toBe('uncertain');
    expect(inbox.unreadInboxItems('conv-c')).toHaveLength(0);
  });

  it('holds a batch the previous run had seen acknowledged but not incorporated', async () => {
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'use PEACH' });
    inbox.reserveInboxItems([id], 'res-1');
    inbox.markInboxReservation('res-1', 'accepted');

    expect(inbox.resolveReservationsAtStartup()).toEqual({ released: 0, unresolved: 1 });
    expect(inbox.getInboxItem(id)?.reservation_state).toBe('uncertain');
  });

  it('does not touch an already-uncertain batch, however many times it restarts', async () => {
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'use PEACH' });
    inbox.reserveInboxItems([id], 'res-1');
    inbox.markInboxReservation('res-1', 'uncertain');

    expect(inbox.resolveReservationsAtStartup()).toEqual({ released: 0, unresolved: 0 });
    expect(inbox.resolveReservationsAtStartup()).toEqual({ released: 0, unresolved: 0 });
    expect(inbox.getInboxItem(id)?.reservation_state).toBe('uncertain');
  });
});

describe('settling a held batch by hand', () => {
  it('puts it back in the inbox when it turns out never to have arrived', async () => {
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'use PEACH' });
    inbox.reserveInboxItems([id], 'res-1');
    inbox.markInboxReservation('res-1', 'uncertain');

    expect(inbox.resolveUncertainReservation('res-1', 'release')).toBe(1);
    expect(inbox.unreadInboxItems('conv-c').map((r) => r.id)).toEqual([id]);
  });

  it('marks it read when it turns out to have arrived', async () => {
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'use PEACH' });
    inbox.reserveInboxItems([id], 'res-1');
    inbox.markInboxReservation('res-1', 'uncertain');

    expect(inbox.resolveUncertainReservation('res-1', 'delivered')).toBe(1);
    expect(inbox.getInboxItem(id)?.read_at).not.toBeNull();
    expect(inbox.unreadInboxItems('conv-c')).toHaveLength(0);
  });

  it('does nothing to a batch that is not held', async () => {
    const id = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'use PEACH' });
    inbox.reserveInboxItems([id], 'res-1');

    expect(inbox.resolveUncertainReservation('res-1', 'delivered')).toBe(0);
    expect(inbox.getInboxItem(id)?.read_at).toBeNull();
  });
});

describe('the quick answer handed over on its own', () => {
  it('reads as the automatic answer to the message it answers, not as the user', async () => {
    const question = inbox.enqueueInboxItem({
      sessionId: 'conv-c', source: 'user', text: 'what is the status?',
    });
    const answer = inbox.enqueueInboxItem({
      sessionId: 'conv-c', source: 'quick-answer', text: 'The migration is applied.', answersId: question,
    });
    inbox.markInboxItemsRead([question], 9);

    const rows = inbox.unreadInboxItems('conv-c');
    expect(rows.map((r) => r.id)).toEqual([answer]);
    const composed = inbox.composeInboxInput(rows, 'lattice', { midTurn: true });

    expect(composed).toContain('Automatic quick answer');
    expect(composed).toContain('The migration is applied.');
    // The original went in when it arrived; repeating it here would be the
    // coordinator reading the same message twice.
    expect(composed).not.toContain('what is the status?');
    // And it is tied to the message it answers, by the time that arrived.
    expect(composed).toContain('to their message of');
    expect(composed).not.toContain('[From the user');
  });

  it('carries its own delivery status, separate from the message it answers', async () => {
    const question = inbox.enqueueInboxItem({ sessionId: 'conv-c', source: 'user', text: 'what is the status?' });
    inbox.markInboxItemsRead([question], 9);
    const answer = inbox.enqueueInboxItem({
      sessionId: 'conv-c', source: 'quick-answer', text: 'The migration is applied.', answersId: question,
    });

    const fake = manager({ outcome: { status: 'uncertain', reason: 'no acknowledgement' }, duringCall: [HANDED] });
    const result = await deliver(fake.manager, 'conv-c', answer);

    // The question was delivered; the answer was not. Two facts, two rows.
    expect(result.status).toBe('uncertain');
    expect(inbox.getInboxItem(question)?.read_at).not.toBeNull();
    expect(inbox.getInboxItem(answer)).toMatchObject({ read_at: null, reservation_state: 'uncertain' });
  });
});
