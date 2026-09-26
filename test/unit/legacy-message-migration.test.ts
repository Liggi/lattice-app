import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { legacyRowsToEvents, migrateLegacyHistoryToEvents } from '@/harness/legacy-message-migration.js';
import { eventsToUnifiedMessages } from '@/harness/event-message-reader.js';
import { SqliteEventStorageAdapter } from '@/harness/sqlite-event-storage.js';

/** Build a legacy `messages` row the way the pre-cutover MessageStore wrote it. */
function row(
  role: 'user' | 'assistant' | 'system',
  content: unknown[],
  opts: { timestamp?: string; provider?: string; providerMessageId?: string } = {},
) {
  const timestamp = opts.timestamp ?? '2026-03-01T12:00:00.000Z';
  return {
    role,
    provider: opts.provider ?? 'claude',
    timestamp,
    message_json: JSON.stringify({ id: 'legacy-1', provider: opts.provider ?? 'claude', role, content, timestamp }),
    provider_message_id: opts.providerMessageId ?? null,
  };
}

/** The migration is only correct if the reader turns its output back into the input. */
function roundTrip(rows: ReturnType<typeof row>[]) {
  return eventsToUnifiedMessages(legacyRowsToEvents('conv-test', rows));
}

describe('legacyRowsToEvents', () => {
  it('round-trips a user text message', () => {
    const messages = roundTrip([row('user', [{ type: 'text', text: 'hello there' }])]);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toEqual([{ type: 'text', text: 'hello there' }]);
  });

  it('round-trips assistant text and tool_use', () => {
    const messages = roundTrip([
      row('assistant', [
        { type: 'text', text: 'running it' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      ]),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'running it' },
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
    ]);
  });

  // The reader reads `block.thinking`; UnifiedContentBlock stores the prose in
  // `.text`. Emitting `.text` here silently drops every thinking block.
  it('preserves thinking blocks across the field rename', () => {
    const messages = roundTrip([row('assistant', [{ type: 'thinking', text: 'let me consider' }])]);
    expect(messages[0].content).toEqual([{ type: 'thinking', text: 'let me consider' }]);
  });

  // Reader expects snake_case tool_result fields, not UnifiedContentBlock's camelCase.
  it('preserves tool_result fields across the case change', () => {
    const messages = roundTrip([
      row('user', [{ type: 'tool_result', toolUseId: 'toolu_1', output: 'file.txt', isError: false }]),
    ]);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toEqual([
      { type: 'tool_result', toolUseId: 'toolu_1', output: 'file.txt', isError: false },
    ]);
  });

  it('carries the error flag on failed tool results', () => {
    const messages = roundTrip([
      row('user', [{ type: 'tool_result', toolUseId: 'toolu_2', output: 'boom', isError: true }]),
    ]);
    expect(messages[0].content[0]).toMatchObject({ isError: true });
  });

  it('skips system rows, which have no harness event equivalent', () => {
    expect(legacyRowsToEvents('conv-test', [row('system', [{ type: 'text', text: 'ignored' }])])).toEqual([]);
  });

  it('drops a duplicate user input inside the dedup window', () => {
    const messages = roundTrip([
      row('user', [{ type: 'text', text: 'same' }], { timestamp: '2026-03-01T12:00:00.000Z' }),
      row('user', [{ type: 'text', text: 'same' }], { timestamp: '2026-03-01T12:00:02.000Z' }),
    ]);
    expect(messages).toHaveLength(1);
  });

  it('keeps a repeated user input outside the dedup window', () => {
    const messages = roundTrip([
      row('user', [{ type: 'text', text: 'same' }], { timestamp: '2026-03-01T12:00:00.000Z' }),
      row('user', [{ type: 'text', text: 'same' }], { timestamp: '2026-03-01T12:00:30.000Z' }),
    ]);
    expect(messages).toHaveLength(2);
  });

  // Provider survives only via a run:start carrying config.extra.provider.
  it('tags codex conversations so they do not read back as claude', () => {
    const messages = roundTrip([row('user', [{ type: 'text', text: 'hi' }], { provider: 'codex' })]);
    expect(messages[0].provider).toBe('codex');
  });

  it('defaults to claude when no codex marker is present', () => {
    const messages = roundTrip([row('user', [{ type: 'text', text: 'hi' }])]);
    expect(messages[0].provider).toBe('claude');
  });

  it('emits a tool_result and a text message from one mixed user row', () => {
    const messages = roundTrip([
      row('user', [
        { type: 'tool_result', toolUseId: 'toolu_1', output: 'done', isError: false },
        { type: 'text', text: 'now do the next thing' },
      ]),
    ]);
    expect(messages.map(m => m.content[0].type)).toEqual(['tool_result', 'text']);
  });

  it('ignores rows with unparseable json or a bad timestamp', () => {
    const broken = [
      { role: 'user', provider: 'claude', timestamp: '2026-03-01T12:00:00.000Z', message_json: '{not json', provider_message_id: null },
      { role: 'user', provider: 'claude', timestamp: 'not-a-date', message_json: JSON.stringify({ content: [{ type: 'text', text: 'x' }] }), provider_message_id: null },
    ];
    expect(legacyRowsToEvents('conv-test', broken)).toEqual([]);
  });

  it('assigns strictly increasing seqs so the primary key cannot collide', () => {
    const events = legacyRowsToEvents('conv-test', [
      row('user', [{ type: 'text', text: 'one' }], { timestamp: '2026-03-01T12:00:00.000Z' }),
      row('assistant', [{ type: 'text', text: 'two' }], { timestamp: '2026-03-01T12:00:01.000Z' }),
      row('user', [{ type: 'text', text: 'three' }], { timestamp: '2026-03-01T12:00:20.000Z' }),
    ]);
    const seqs = events.map(e => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe('migrateLegacyHistoryToEvents', () => {
  function seed(
    rows: Array<{ id: string; session_id: string; role: string; content: unknown[] }>,
    opts: { conversations?: string[]; segments?: Array<[string, string]> } = {},
  ) {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE conversations (conversation_id TEXT PRIMARY KEY);
      CREATE TABLE conversation_segments (
        conversation_id TEXT NOT NULL, provider_session_id TEXT, sequence_number INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, provider TEXT NOT NULL,
        role TEXT NOT NULL, timestamp TEXT NOT NULL, message_json TEXT NOT NULL,
        streaming_id TEXT, provider_message_id TEXT
      );
    `);

    // Only conv-* IDs are real conversations; a provider UUID never is.
    const conversationIds = opts.conversations
      ?? [...new Set(rows.map(r => r.session_id).filter(id => id.startsWith('conv-')))];
    const addConversation = db.prepare('INSERT OR IGNORE INTO conversations (conversation_id) VALUES (?)');
    for (const id of conversationIds) addConversation.run(id);

    const addSegment = db.prepare(
      'INSERT INTO conversation_segments (conversation_id, provider_session_id, sequence_number) VALUES (?,?,?)'
    );
    (opts.segments ?? []).forEach(([conversationId, providerSessionId], i) =>
      addSegment.run(conversationId, providerSessionId, i));

    const insert = db.prepare(
      'INSERT INTO messages (id, session_id, provider, role, timestamp, message_json, provider_message_id) VALUES (?,?,?,?,?,?,?)'
    );
    for (const r of rows) {
      insert.run(r.id, r.session_id, 'claude', r.role, '2026-03-01T12:00:00.000Z',
        JSON.stringify({ role: r.role, content: r.content }), null);
    }
    return db;
  }

  // Rollback selector: run_id cannot be used, because the old lazy backfill
  // wrote the same `backfill-` prefix. The explicit list is what makes undo safe.
  it('records exactly which conversations it filled', async () => {
    const db = seed([
      { id: 'm1', session_id: 'conv-abc', role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { id: 'm2', session_id: 'conv-def', role: 'user', content: [{ type: 'text', text: 'yo' }] },
    ]);
    db.prepare('INSERT INTO conversations (conversation_id) VALUES (?)').run('conv-untouched');
    const storage = new SqliteEventStorageAdapter(db);
    await migrateLegacyHistoryToEvents(db, storage);

    const row = db.prepare('SELECT value FROM metadata WHERE key = ?')
      .get('harness_events_backfill_v1_conversations') as { value: string };
    expect(JSON.parse(row.value).sort()).toEqual(['conv-abc', 'conv-def']);
  });

  it('records nothing when a conversation already had events', async () => {
    const db = seed([{ id: 'm1', session_id: 'conv-abc', role: 'user', content: [{ type: 'text', text: 'legacy' }] }]);
    const storage = new SqliteEventStorageAdapter(db);
    storage.write({ sessionId: 'conv-abc', seq: 1, runId: 'live', timestamp: Date.now(), type: 'input:sent', data: { text: 'live' } } as never);

    await migrateLegacyHistoryToEvents(db, storage);

    const row = db.prepare('SELECT value FROM metadata WHERE key = ?')
      .get('harness_events_backfill_v1_conversations') as { value: string };
    expect(JSON.parse(row.value)).toEqual([]);
  });

  it('migrates conv-* keyed rows and sets the marker', async () => {
    const db = seed([{ id: 'm1', session_id: 'conv-abc', role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    const storage = new SqliteEventStorageAdapter(db);
    await migrateLegacyHistoryToEvents(db, storage);

    expect((db.prepare('SELECT COUNT(*) c FROM harness_events').get() as { c: number }).c).toBe(1);
    expect(db.prepare('SELECT value FROM metadata WHERE key = ?')
      .get('harness_events_backfilled_from_legacy_messages_v1')).toEqual({ value: 'true' });
  });

  // Provider-UUID keys are unreachable from the read path, which looks up conv-*.
  it('leaves orphan provider-UUID keyed rows alone', async () => {
    const db = seed([{ id: 'm1', session_id: 'b968e792-8898-4d1e-9c1a-000000000000', role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    const storage = new SqliteEventStorageAdapter(db);
    await migrateLegacyHistoryToEvents(db, storage);
    expect((db.prepare('SELECT COUNT(*) c FROM harness_events').get() as { c: number }).c).toBe(0);
  });

  it('skips conversations that already have events', async () => {
    const db = seed([{ id: 'm1', session_id: 'conv-abc', role: 'user', content: [{ type: 'text', text: 'legacy' }] }]);
    const storage = new SqliteEventStorageAdapter(db);
    storage.write({ sessionId: 'conv-abc', seq: 1, runId: 'live', timestamp: Date.now(), type: 'input:sent', data: { text: 'live' } } as never);

    await migrateLegacyHistoryToEvents(db, storage);
    const events = db.prepare('SELECT run_id FROM harness_events').all() as Array<{ run_id: string }>;
    expect(events).toEqual([{ run_id: 'live' }]);
  });

  it('is idempotent — a second run writes nothing new', async () => {
    const db = seed([{ id: 'm1', session_id: 'conv-abc', role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    const storage = new SqliteEventStorageAdapter(db);
    await migrateLegacyHistoryToEvents(db, storage);
    const after = (db.prepare('SELECT COUNT(*) c FROM harness_events').get() as { c: number }).c;
    await migrateLegacyHistoryToEvents(db, storage);
    expect((db.prepare('SELECT COUNT(*) c FROM harness_events').get() as { c: number }).c).toBe(after);
  });

  // Source 2: a colleague's machine stored some history under the provider
  // session key. Keying the events by conv-* is what makes them readable.
  it('remaps history stored under a provider session key onto the conversation', async () => {
    const uuid = 'b968e792-8898-4d1e-9c1a-000000000000';
    const db = seed(
      [{ id: 'm1', session_id: uuid, role: 'user', content: [{ type: 'text', text: 'older key' }] }],
      { conversations: ['conv-abc'], segments: [['conv-abc', uuid]] },
    );
    const storage = new SqliteEventStorageAdapter(db);
    await migrateLegacyHistoryToEvents(db, storage);

    const keys = db.prepare('SELECT DISTINCT session_id s FROM harness_events').all() as Array<{ s: string }>;
    expect(keys).toEqual([{ s: 'conv-abc' }]);
  });

  // Source 1 wins, so the remap cannot duplicate history the conversation already has.
  it('does not remap when the conversation has its own legacy rows', async () => {
    const uuid = 'b968e792-8898-4d1e-9c1a-000000000000';
    const db = seed(
      [
        { id: 'm1', session_id: 'conv-abc', role: 'user', content: [{ type: 'text', text: 'primary' }] },
        { id: 'm2', session_id: uuid, role: 'user', content: [{ type: 'text', text: 'straggler' }] },
      ],
      { conversations: ['conv-abc'], segments: [['conv-abc', uuid]] },
    );
    const storage = new SqliteEventStorageAdapter(db);
    await migrateLegacyHistoryToEvents(db, storage);

    const events = db.prepare('SELECT data FROM harness_events').all() as Array<{ data: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].data).toContain('primary');
  });

  // 'imported-*' segments never had a provider session, so there is no transcript to find.
  it('does not look for a transcript for imported segments', async () => {
    const db = seed([], { conversations: ['conv-imported'], segments: [['conv-imported', 'imported-1773955791704']] });
    const storage = new SqliteEventStorageAdapter(db);
    await migrateLegacyHistoryToEvents(db, storage);
    expect((db.prepare('SELECT COUNT(*) c FROM harness_events').get() as { c: number }).c).toBe(0);
  });

  // A JSONL-only conversation cannot be migrated and the read path no longer
  // consults JSONL, so it must be reported rather than silently rendered empty.
  it('reports conversations left with no history', async () => {
    const db = seed([{ id: 'm1', session_id: 'conv-abc', role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    db.prepare('INSERT INTO conversations (conversation_id) VALUES (?)').run('conv-jsonl-only');
    const storage = new SqliteEventStorageAdapter(db);

    await migrateLegacyHistoryToEvents(db, storage);

    // conv-abc migrated; conv-jsonl-only has no legacy rows and no events.
    const remaining = db.prepare(`
      SELECT COUNT(*) c FROM conversations c2
      WHERE NOT EXISTS (SELECT 1 FROM harness_events e WHERE e.session_id = c2.conversation_id)
    `).get() as { c: number };
    expect(remaining.c).toBe(1);
  });

  it('survives a database with no conversations table', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, provider TEXT NOT NULL,
        role TEXT NOT NULL, timestamp TEXT NOT NULL, message_json TEXT NOT NULL,
        streaming_id TEXT, provider_message_id TEXT
      );
    `);
    db.prepare('INSERT INTO messages (id, session_id, provider, role, timestamp, message_json, provider_message_id) VALUES (?,?,?,?,?,?,?)')
      .run('m1', 'conv-abc', 'claude', 'user', '2026-03-01T12:00:00.000Z',
        JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'hi' }] }), null);

    const storage = new SqliteEventStorageAdapter(db);
    await migrateLegacyHistoryToEvents(db, storage);

    // The migration must complete, not abort part-way through its reporting.
    expect((db.prepare('SELECT COUNT(*) c FROM harness_events').get() as { c: number }).c).toBe(1);
    expect(db.prepare('SELECT value FROM metadata WHERE key = ?')
      .get('harness_events_backfilled_from_legacy_messages_v1')).toEqual({ value: 'true' });
  });

  it('no-ops on a fresh install with no legacy table', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    const storage = new SqliteEventStorageAdapter(db);
    await expect(migrateLegacyHistoryToEvents(db, storage)).resolves.toBeUndefined();
    expect((db.prepare('SELECT COUNT(*) c FROM harness_events').get() as { c: number }).c).toBe(0);
  });
});
