/**
 * Feedback stays a local draft until the user sends the exact payload they
 * reviewed. Agents cannot save drafts while feedback is off, cannot pile them
 * up, and an edit or a new destination voids what was reviewed.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { FeedbackService } from '../../src/services/feedback/feedback-service.js';
import { FeedbackInbox } from '../../src/services/feedback/feedback-inbox.js';
import type { FeedbackConfig } from '../../src/types/config.js';

const COLLECTOR = 'http://localhost:8791';

function setup(config: FeedbackConfig, fetchImpl?: typeof fetch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-test-'));
  const current = { ...config };
  const proposals: string[] = [];
  const service = new FeedbackService(
    () => current,
    (id) => (id.startsWith('conv-') ? { provider: 'claude', model: 'claude-opus-5-5' } : null),
    () => false,
    dir,
    fetchImpl,
    (draft) => proposals.push(draft.id),
  );
  return { service, current, dir, proposals };
}

/** A collector that answers each request with the next canned response, recording what it was sent. */
function collector(answers: Array<[number, Record<string, unknown>]>) {
  const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const [status, body] = answers.shift()!;
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}

describe('feedback drafts', () => {
  it('is on when nothing is set, and refuses to save anything once switched off', () => {
    const { service: unset } = setup({ collectorUrl: COLLECTOR });
    expect(unset.status().enabled).toBe(true);
    const { service, dir } = setup({ collectorUrl: COLLECTOR, enabled: false });
    expect(service.status().enabled).toBe(false);
    expect(() => service.createDraft({ source: 'agent', message: 'hi' })).toThrow(/switched off/);
    expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(false);
  });

  it('puts a card in the chat for an agent proposal about a session, and only then', () => {
    const { service, proposals } = setup({ enabled: true, collectorUrl: COLLECTOR });
    const carded = service.createDraft({ source: 'agent', message: 'about a session', conversationId: 'conv-a' });
    service.createDraft({ source: 'agent', message: 'about Lattice' });
    service.createDraft({ source: 'human', message: 'mine', conversationId: 'conv-b' });
    expect(proposals).toEqual([carded.id]);
    expect(carded.payload.session_ref).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('holds one agent proposal per session and five per install', () => {
    const { service } = setup({ enabled: true, collectorUrl: COLLECTOR });
    service.createDraft({ source: 'agent', message: 'one', conversationId: 'conv-a' });
    expect(() => service.createDraft({ source: 'agent', message: 'two', conversationId: 'conv-a' })).toThrow(/already has a feedback draft/);
    for (let i = 0; i < 4; i++) service.createDraft({ source: 'agent', message: `app ${i}` });
    expect(() => service.createDraft({ source: 'agent', message: 'sixth' })).toThrow(/limit is 5/);
    expect(service.createDraft({ source: 'human', message: 'people are not limited here' }).source).toBe('human');
  });

  it('rejects an over-long message rather than cutting it', () => {
    const { service } = setup({ enabled: true, collectorUrl: COLLECTOR });
    expect(() => service.createDraft({ source: 'human', message: 'x'.repeat(6001) })).toThrow(/limit is 6000/);
  });

  it('gives an edited draft a new revision and submission ID, and refuses the old revision', async () => {
    const { service } = setup({ enabled: true, collectorUrl: COLLECTOR });
    const draft = service.createDraft({ source: 'agent', message: 'first' });
    const edited = service.updateDraft(draft.id, { message: 'second' });
    expect(edited.revision).toBe(draft.revision + 1);
    expect(edited.payload.submission_id).not.toBe(draft.payload.submission_id);
    await expect(service.send(draft.id, draft.revision)).rejects.toThrow(/changed after you reviewed it/);
  });

  it('strands drafts when the destination changes', async () => {
    const { service, current } = setup({ enabled: true, collectorUrl: COLLECTOR });
    const draft = service.createDraft({ source: 'human', message: 'hello' });
    current.collectorUrl = 'https://other.example.com';
    expect(service.listDrafts()[0].sendable).toBe(false);
    await expect(service.send(draft.id, draft.revision)).rejects.toThrow(/different feedback destination/);
  });

  it('trades the check ticket for a key and sends with it, keeping the draft when refused', async () => {
    const { service, dir } = setup({ enabled: true, collectorUrl: COLLECTOR });
    const draft = service.createDraft({ source: 'agent', message: 'hello', conversationId: 'conv-a' });
    await expect(service.send(draft.id, draft.revision)).rejects.toMatchObject({ code: 'verification_required' });

    const { installId } = service.registration();
    const { requests, fetchImpl } = collector([
      [201, { install_id: installId, install_key: 'lfk_secret', created_at: '2026-09-27T10:00:00.000Z' }],
      [429, { error: 'rate_limited', message: 'Too many.', retry_after_seconds: 600 }],
      [201, { id: 'item-1', submission_id: draft.payload.submission_id, received_at: '2026-09-27T10:00:00.000Z', duplicate: false }],
    ]);
    const keyed = new FeedbackService(() => ({ enabled: true, collectorUrl: COLLECTOR }), () => ({ provider: 'claude', model: null }), () => false, dir, fetchImpl);
    await keyed.register('ticket-1');
    expect(requests[0]).toMatchObject({ url: `${COLLECTOR}/v1/installs`, body: { install_id: installId, ticket: 'ticket-1' } });
    expect(keyed.status().registered).toBe(true);
    expect(JSON.stringify(keyed.status())).not.toContain('lfk_secret');

    const refused = await keyed.send(draft.id, draft.revision);
    expect(refused.error?.message).toBe('Too many. Try again in 10 min.');
    expect(keyed.proposal(draft.id).state).toBe('pending');
    expect(requests[1].headers.authorization).toBe('Bearer lfk_secret');
    expect(requests[1].body).toEqual(draft.payload);

    const sent = await keyed.send(draft.id, draft.revision);
    expect(sent).toMatchObject({ sent: true, receipt: { id: 'item-1' } });
    expect(keyed.listDrafts()).toHaveLength(0);
    expect(keyed.proposal(draft.id)).toMatchObject({ state: 'sent', message: 'hello' });
  });

  it('forgets a key the collector no longer accepts, and asks for the check again', async () => {
    const { service, dir } = setup({ enabled: true, collectorUrl: COLLECTOR });
    const { installId } = service.registration();
    const { fetchImpl } = collector([
      [201, { install_id: installId, install_key: 'lfk_old', created_at: '2026-09-27T10:00:00.000Z' }],
      [401, { error: 'invalid_install_key', message: 'Revoked.' }],
    ]);
    const keyed = new FeedbackService(() => ({ enabled: true, collectorUrl: COLLECTOR }), () => null, () => false, dir, fetchImpl);
    await keyed.register('ticket');
    const draft = keyed.createDraft({ source: 'human', message: 'hello' });
    await expect(keyed.send(draft.id, draft.revision)).rejects.toMatchObject({ code: 'verification_required' });
    expect(keyed.status().registered).toBe(false);
    expect(keyed.listDrafts()).toHaveLength(1);
  });

  it('records a rejected agent proposal so its card can say so', () => {
    const { service } = setup({ enabled: true, collectorUrl: COLLECTOR });
    const draft = service.createDraft({ source: 'agent', message: 'meh', conversationId: 'conv-a' });
    service.deleteDraft(draft.id);
    expect(service.proposal(draft.id).state).toBe('rejected');
    expect(service.proposal('fbd-unknown').state).toBe('gone');
  });
});

describe('feedback inbox', () => {
  it('exists only with a private token file, and applies tombstones', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-inbox-test-'));
    const tokenFile = path.join(dir, 'feedback-inbox.json');
    const pages = [
      { items: [
        { id: 'a', cursor: 1, deleted: false, received_at: '2099-01-01T00:00:00Z', message: 'first', category: 'bug', classification_state: 'pending' },
        { id: 'b', cursor: 2, deleted: false, received_at: '2099-01-02T00:00:00Z', message: 'second', category: 'other', classification_state: 'classified', off_topic: true, abusive: false },
      ], next_cursor: 2, has_more: false },
      { items: [{ id: 'a', cursor: 3, deleted: true }], next_cursor: 3, has_more: false },
    ];
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
      return new Response(JSON.stringify(pages.shift()), { status: 200 });
    }) as unknown as typeof fetch;
    const inbox = new FeedbackInbox(tokenFile, dir, fetchImpl);
    expect(inbox.available()).toBe(false);

    fs.writeFileSync(tokenFile, JSON.stringify({ collectorUrl: COLLECTOR, readToken: 'secret-token-123' }), { mode: 0o644 });
    fs.chmodSync(tokenFile, 0o644);
    await expect(inbox.list('all')).rejects.toThrow(/chmod 600/);
    fs.chmodSync(tokenFile, 0o600);

    const first = await inbox.list('all');
    expect(first.items.map((item) => item.id)).toEqual(['b', 'a']);
    expect(first.counts).toEqual({ unread: 2, all: 2, flagged: 1 });
    expect(seen[0]).toBe(`${COLLECTOR}/v1/changes?after=0&limit=200 Bearer secret-token-123`);

    inbox.mark('b', { done: true });
    await inbox.refresh(true);
    const second = await inbox.list('all');
    expect(seen[1]).toContain('after=2');
    expect(second.items.map((item) => item.id)).toEqual(['b']);
    expect(second.counts.unread).toBe(0);
  });
});
