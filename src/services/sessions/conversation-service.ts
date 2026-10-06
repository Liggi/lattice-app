import crypto from 'crypto';
import type Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';
import { createLogger } from '../infrastructure/logger.js';

const logger = createLogger('ConversationService');

// --- ID generation ---

function generateConversationId(): string {
  return `conv-${crypto.randomBytes(9).toString('base64url').slice(0, 12)}`;
}

function generateSegmentId(): string {
  return `seg-${crypto.randomBytes(6).toString('base64url').slice(0, 8)}`;
}

/**
 * When a conversation was last actually used. Prefers its newest harness
 * event, because `updated_at` only moves on the legacy /resume route and on
 * segment changes — for most conversations it never leaves creation time.
 * Queries that don't select `last_event_ms` fall back to `updated_at`.
 */
function resolveLastActivityAt(row: ConversationRow): string {
  return row.last_event_ms
    ? new Date(row.last_event_ms).toISOString()
    : row.updated_at;
}

// --- Types ---

import type { Provider } from '@/types/unified-messages.js';

export type { Provider };
export type SegmentStatus = 'active' | 'completed' | 'failed';

export interface ConversationSegment {
  segmentId: string;
  conversationId: string;
  provider: Provider;
  providerSessionId: string;
  sequenceNumber: number;
  createdAt: string;
  endedAt: string | null;
  status: SegmentStatus;
  model: string | null;
  /**
   * The Codex reasoning effort the segment is currently running at: written at
   * creation and whenever a setting is actually applied to a thread or turn
   * (see codex-effort.ts). Null for other providers and for Codex segments
   * from before the column existed, whose setting is genuinely unknown.
   */
  reasoningEffort: string | null;
  streamingId: string | null;
}

export interface Conversation {
  conversationId: string;
  createdAt: string;
  updatedAt: string;
  /**
   * When the conversation was last actually used, from its newest harness
   * event. `updatedAt` only moves on the legacy /resume route and segment
   * changes, so it is creation time for most conversations. Falls back to
   * `updatedAt` when a conversation has no events.
   */
  lastActivityAt: string;
  /** When it was archived; only set by the archived list, null when not recorded. */
  archivedAt?: string | null;
  workingDirectory: string;
  workspace: string;
  latestProvider: Provider | null;
  latestSegmentId: string | null;
  initialPrompt: string | null;
  /**
   * The conversation this one was picked up from — a coordinator that
   * dispatched it as a worker. The child inherits the parent's working
   * directory and workspace, and its turn-end reports are delivered back
   * to the parent (see worker-report-delivery.ts). Distinct from a branch,
   * which copies history; a pickup starts fresh with a reference.
   */
  pickedUpFrom: string | null;
  /**
   * Started as `front`, the coordinator persona (see pickup-prompts.ts).
   * Persisted so the server can restore the coordinator's preamble and worker
   * roster after a context compaction without guessing from the transcript.
   */
  coordinator: boolean;
  segments: ConversationSegment[];
}

export interface ConversationRow {
  conversation_id: string;
  created_at: string;
  updated_at: string;
  /** Epoch ms of the newest harness event. Only selected by the list queries. */
  last_event_ms?: number | null;
  /** Only selected by the archived list query. */
  archived_at?: string | null;
  working_directory: string;
  workspace: string;
  latest_provider: string | null;
  latest_segment_id: string | null;
  initial_prompt: string | null;
  picked_up_from: string | null;
  coordinator?: number | null;
}

export interface SegmentRow {
  segment_id: string;
  conversation_id: string;
  provider: string;
  provider_session_id: string;
  sequence_number: number;
  created_at: string;
  ended_at: string | null;
  status: string;
  model: string | null;
  reasoning_effort?: string | null;
  streaming_id: string | null;
}

// --- Service ---

/**
 * Manages the conversation → segment mapping layer.
 *
 * A conversation is a stable identity that the user sees as "one chat."
 * Segments are provider-specific sessions within that conversation
 * (e.g., segment 1 = Claude, segment 2 = Codex, segment 3 = Claude again).
 *
 * This service does NOT own session metadata (name, pinned, insights, etc.) —
 * that stays in SessionInfoService, keyed by the provider session ID.
 * It also does NOT spawn processes — that's done by the routes layer.
 */
export class ConversationService {
  private db!: Database.Database;
  private initialized = false;

  // Prepared statements
  private stmts!: {
    insertConversation: Statement;
    insertSegment: Statement;
    updateConversationLatest: Statement;
    updateConversationTimestamp: Statement;
    endSegment: Statement;
    getConversation: Statement;
    getSegments: Statement;
    getSegmentById: Statement;
    getLatestSegment: Statement;
    getConversationByProviderSession: Statement;
    listConversations: Statement;
    listNonArchivedConversations: Statement;
    listArchivedConversations: Statement;
    countArchivedConversations: Statement;
    countNonArchivedConversations: Statement;
    countConversations: Statement;
    addConversationIdToSession: Statement;
    insertArchivedSessionRow: Statement;
    getCreatedHidden: Statement;
  };

  // Singleton
  private static instance: ConversationService | null = null;

  static getInstance(): ConversationService {
    if (!ConversationService.instance) {
      ConversationService.instance = new ConversationService();
    }
    return ConversationService.instance;
  }

  static resetInstance(): void {
    ConversationService.instance = null;
  }

  /**
   * Initialize with a database handle. Must be called after SessionInfoService
   * has created/opened the database (we share the same .db file).
   */
  initialize(db: Database.Database): void {
    if (this.initialized) return;
    this.db = db;
    this.createTables();
    this.prepareStatements();
    this.initialized = true;
    logger.info('ConversationService initialized');
  }

  // --- Schema ---

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        conversation_id   TEXT PRIMARY KEY,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        workspace         TEXT NOT NULL DEFAULT 'main',
        latest_provider   TEXT,
        latest_segment_id TEXT
      );

      CREATE TABLE IF NOT EXISTS conversation_segments (
        segment_id          TEXT PRIMARY KEY,
        conversation_id     TEXT NOT NULL,
        provider            TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        sequence_number     INTEGER NOT NULL,
        created_at          TEXT NOT NULL,
        ended_at            TEXT,
        status              TEXT NOT NULL DEFAULT 'active',
        model               TEXT,
        streaming_id        TEXT,

        FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id),
        UNIQUE(conversation_id, sequence_number)
      );

      CREATE INDEX IF NOT EXISTS idx_segments_conversation
        ON conversation_segments(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_segments_provider_session
        ON conversation_segments(provider_session_id);
    `);

    // Add conversation_id column to sessions table if it doesn't exist
    try {
      const tableInfo = this.db.pragma('table_info(sessions)') as Array<{ name: string }>;
      const columnNames = tableInfo.map(col => col.name);
      if (!columnNames.includes('conversation_id')) {
        this.db.exec('ALTER TABLE sessions ADD COLUMN conversation_id TEXT DEFAULT NULL');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_conversation ON sessions(conversation_id)');
        logger.info('Added conversation_id column to sessions table');
      }
    } catch (error) {
      logger.debug('Sessions conversation_id migration check', { error });
    }

    // Add initial_prompt column to conversations table if it doesn't exist
    try {
      const convTableInfo = this.db.pragma('table_info(conversations)') as Array<{ name: string }>;
      const convColumnNames = convTableInfo.map(col => col.name);
      if (!convColumnNames.includes('initial_prompt')) {
        this.db.exec('ALTER TABLE conversations ADD COLUMN initial_prompt TEXT DEFAULT NULL');
        logger.info('Added initial_prompt column to conversations table');
      }
    } catch (error) {
      logger.debug('Conversations initial_prompt migration check', { error });
    }

    // Add picked_up_from column to conversations table if it doesn't exist
    try {
      const convTableInfo = this.db.pragma('table_info(conversations)') as Array<{ name: string }>;
      const convColumnNames = convTableInfo.map(col => col.name);
      if (!convColumnNames.includes('picked_up_from')) {
        this.db.exec('ALTER TABLE conversations ADD COLUMN picked_up_from TEXT DEFAULT NULL');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_picked_up_from ON conversations(picked_up_from)');
        logger.info('Added picked_up_from column to conversations table');
      }
    } catch (error) {
      logger.debug('Conversations picked_up_from migration check', { error });
    }

    // Add coordinator column to conversations table if it doesn't exist
    try {
      const convTableInfo = this.db.pragma('table_info(conversations)') as Array<{ name: string }>;
      const convColumnNames = convTableInfo.map(col => col.name);
      if (!convColumnNames.includes('coordinator')) {
        this.db.exec('ALTER TABLE conversations ADD COLUMN coordinator INTEGER NOT NULL DEFAULT 0');
        logger.info('Added coordinator column to conversations table');
      }
    } catch (error) {
      logger.debug('Conversations coordinator migration check', { error });
    }

    // Codex service tier the conversation was created on (e.g. `priority`,
    // Codex's Fast). NULL is the default tier.
    try {
      const convTableInfo = this.db.pragma('table_info(conversations)') as Array<{ name: string }>;
      if (!convTableInfo.some(col => col.name === 'service_tier')) {
        this.db.exec('ALTER TABLE conversations ADD COLUMN service_tier TEXT DEFAULT NULL');
        logger.info('Added service_tier column to conversations table');
      }
    } catch (error) {
      logger.debug('Conversations service_tier migration check', { error });
    }

    // Add reasoning_effort to segments if it doesn't exist. Nullable on
    // purpose: an existing segment's setting was never recorded, and NULL says
    // "unknown" rather than claiming a default was somebody's choice.
    try {
      const segTableInfo = this.db.pragma('table_info(conversation_segments)') as Array<{ name: string }>;
      const segColumnNames = segTableInfo.map(col => col.name);
      if (!segColumnNames.includes('reasoning_effort')) {
        this.db.exec('ALTER TABLE conversation_segments ADD COLUMN reasoning_effort TEXT DEFAULT NULL');
        logger.info('Added reasoning_effort column to conversation_segments table');
      }
    } catch (error) {
      logger.debug('Segments reasoning_effort migration check', { error });
    }
  }

  private prepareStatements(): void {
    this.stmts = {
      insertConversation: this.db.prepare(`
        INSERT INTO conversations (conversation_id, created_at, updated_at, working_directory, workspace, latest_provider, latest_segment_id, initial_prompt, picked_up_from, coordinator, service_tier)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),

      insertSegment: this.db.prepare(`
        INSERT INTO conversation_segments (segment_id, conversation_id, provider, provider_session_id, sequence_number, created_at, status, model, reasoning_effort, streaming_id)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `),

      updateConversationLatest: this.db.prepare(`
        UPDATE conversations SET latest_provider = ?, latest_segment_id = ?, updated_at = ? WHERE conversation_id = ?
      `),

      updateConversationTimestamp: this.db.prepare(`
        UPDATE conversations SET updated_at = ? WHERE conversation_id = ?
      `),

      endSegment: this.db.prepare(`
        UPDATE conversation_segments SET ended_at = ?, status = ? WHERE segment_id = ?
      `),

      getConversation: this.db.prepare(`
        SELECT * FROM conversations WHERE conversation_id = ?
      `),

      getSegments: this.db.prepare(`
        SELECT * FROM conversation_segments WHERE conversation_id = ? ORDER BY sequence_number ASC
      `),

      getSegmentById: this.db.prepare(`
        SELECT * FROM conversation_segments WHERE segment_id = ?
      `),

      getLatestSegment: this.db.prepare(`
        SELECT * FROM conversation_segments
        WHERE conversation_id = ?
        ORDER BY sequence_number DESC
        LIMIT 1
      `),

      getConversationByProviderSession: this.db.prepare(`
        SELECT c.*, cs.segment_id as matched_segment_id, cs.provider as matched_provider
        FROM conversation_segments cs
        JOIN conversations c ON c.conversation_id = cs.conversation_id
        WHERE cs.provider_session_id = ?
      `),

      // Ordered by real activity, not `updated_at`. Only the legacy /resume
      // route and segment changes ever touch `updated_at`, so for most
      // conversations it never moves off creation time — sorting by it buries
      // recently-used conversations pages deep. The last harness event is the
      // honest answer, and falls back to `updated_at` when a conversation has
      // no events. The (session_id, timestamp) index makes the MAX an index
      // seek per row.
      listConversations: this.db.prepare(`
        SELECT c.*, (
          SELECT MAX(e.timestamp) FROM harness_events e
          WHERE e.session_id = c.conversation_id
        ) AS last_event_ms
        FROM conversations c
        ORDER BY COALESCE(last_event_ms, CAST(strftime('%s', c.updated_at) AS INTEGER) * 1000) DESC
        LIMIT ? OFFSET ?
      `),

      listNonArchivedConversations: this.db.prepare(`
        SELECT c.*, (
          SELECT MAX(e.timestamp) FROM harness_events e
          WHERE e.session_id = c.conversation_id
        ) AS last_event_ms
        FROM conversations c
        JOIN sessions s ON s.session_id = c.conversation_id
        WHERE s.archived = 0
        ORDER BY s.pinned DESC,
                 COALESCE(last_event_ms, CAST(strftime('%s', c.updated_at) AS INTEGER) * 1000) DESC
        LIMIT ? OFFSET ?
      `),

      // Most recently archived first; rows archived before archived_at existed
      // follow, by last activity.
      listArchivedConversations: this.db.prepare(`
        SELECT c.*, s.archived_at, (
          SELECT MAX(e.timestamp) FROM harness_events e
          WHERE e.session_id = c.conversation_id
        ) AS last_event_ms
        FROM conversations c
        JOIN sessions s ON s.session_id = c.conversation_id
        WHERE s.archived = 1
        ORDER BY s.archived_at IS NULL, s.archived_at DESC,
                 COALESCE(last_event_ms, CAST(strftime('%s', c.updated_at) AS INTEGER) * 1000) DESC
        LIMIT ? OFFSET ?
      `),

      countArchivedConversations: this.db.prepare(`
        SELECT COUNT(*) as count FROM conversations c
        JOIN sessions s ON s.session_id = c.conversation_id
        WHERE s.archived = 1
      `),

      countNonArchivedConversations: this.db.prepare(`
        SELECT COUNT(*) as count FROM conversations c
        JOIN sessions s ON s.session_id = c.conversation_id
        WHERE s.archived = 0
      `),

      countConversations: this.db.prepare(`
        SELECT COUNT(*) as count FROM conversations
      `),

      addConversationIdToSession: this.db.prepare(`
        UPDATE sessions SET conversation_id = ? WHERE session_id = ?
      `),

      // created_hidden = 1 is the record that this row was never meant to be
      // seen, which is what keeps a fixture hidden when its coordinator later
      // sends it something (session-history/repository.ts).
      insertArchivedSessionRow: this.db.prepare(`
        INSERT INTO sessions (session_id, created_at, updated_at, version, archived, workspace, created_hidden)
        VALUES (?, ?, ?, 1, 1, ?, 1)
        ON CONFLICT(session_id) DO UPDATE SET archived = 1, created_hidden = 1
      `),

      getCreatedHidden: this.db.prepare(`
        SELECT 1 FROM sessions
        WHERE (session_id = ? OR conversation_id = ?) AND created_hidden = 1
        LIMIT 1
      `),

    };
  }

  // --- CRUD ---

  /**
   * Create a new conversation with its first segment.
   */
  createConversation(params: {
    workingDirectory: string;
    provider: Provider;
    providerSessionId: string;
    model?: string;
    /** Codex only: the effort the first turn is actually started with. */
    reasoningEffort?: string;
    /** Codex only: the service tier every run of this conversation asks for. */
    serviceTier?: string;
    workspace?: string;
    streamingId?: string;
    initialPrompt?: string;
    pickedUpFrom?: string;
    coordinator?: boolean;
    /**
     * Create the conversation already archived, in the same transaction as
     * the conversation row. A verification fixture needs this: a coordinator
     * is a project the moment its row exists and it is not archived, so
     * creating one and archiving it afterwards puts it in the user's project
     * list for the gap between the two writes.
     */
    archived?: boolean;
  }): { conversationId: string; segmentId: string } {
    const conversationId = generateConversationId();
    const segmentId = generateSegmentId();
    const now = new Date().toISOString();
    const workspace = params.workspace || 'main';

    const run = this.db.transaction(() => {
      this.stmts.insertConversation.run(
        conversationId, now, now, params.workingDirectory,
        workspace, params.provider, segmentId,
        params.initialPrompt || null,
        params.pickedUpFrom || null,
        params.coordinator ? 1 : 0,
        params.serviceTier || null,
      );

      this.stmts.insertSegment.run(
        segmentId, conversationId, params.provider, params.providerSessionId,
        1, now, params.model || null, params.reasoningEffort || null,
        params.streamingId || null,
      );

      // Link the provider session back to this conversation
      this.stmts.addConversationIdToSession.run(conversationId, params.providerSessionId);

      if (params.archived) {
        this.stmts.insertArchivedSessionRow.run(conversationId, now, now, workspace);
      }
    });

    run();

    logger.info('Created conversation', {
      conversationId,
      segmentId,
      provider: params.provider,
      providerSessionId: params.providerSessionId.slice(0, 8),
    });

    return { conversationId, segmentId };
  }

  /**
   * Add a new segment to an existing conversation (provider switch).
   */
  addSegment(conversationId: string, params: {
    provider: Provider;
    providerSessionId: string;
    model?: string;
    /** Codex only: the effort this segment's first turn is started with. */
    reasoningEffort?: string;
    streamingId?: string;
  }): { segmentId: string; sequenceNumber: number } {
    const segmentId = generateSegmentId();
    const now = new Date().toISOString();

    // Get next sequence number
    const latest = this.stmts.getLatestSegment.get(conversationId) as SegmentRow | undefined;
    const sequenceNumber = latest ? latest.sequence_number + 1 : 1;

    const run = this.db.transaction(() => {
      this.stmts.insertSegment.run(
        segmentId, conversationId, params.provider, params.providerSessionId,
        sequenceNumber, now, params.model || null, params.reasoningEffort || null,
        params.streamingId || null,
      );

      this.stmts.updateConversationLatest.run(
        params.provider, segmentId, now, conversationId,
      );

      // Link the provider session back to this conversation
      this.stmts.addConversationIdToSession.run(conversationId, params.providerSessionId);
    });

    run();

    logger.info('Added segment', {
      conversationId,
      segmentId,
      sequenceNumber,
      provider: params.provider,
      providerSessionId: params.providerSessionId.slice(0, 8),
    });

    return { segmentId, sequenceNumber };
  }

  /**
   * Undo an `addSegment` whose switch did not complete (coordinator-switch.ts):
   * the segment is removed and the conversation points at the one before it
   * again. Only the latest segment; returns false, changing nothing, otherwise.
   * Its events stay in the conversation's log either way.
   */
  discardLatestSegment(conversationId: string, segmentId: string): boolean {
    const run = this.db.transaction((): boolean => {
      const latest = this.stmts.getLatestSegment.get(conversationId) as SegmentRow | undefined;
      if (!latest || latest.segment_id !== segmentId) return false;
      this.db.prepare('DELETE FROM conversation_segments WHERE segment_id = ?').run(segmentId);
      const previous = this.stmts.getLatestSegment.get(conversationId) as SegmentRow | undefined;
      this.stmts.updateConversationLatest.run(
        previous?.provider ?? null, previous?.segment_id ?? null, new Date().toISOString(), conversationId,
      );
      return true;
    });
    const discarded = run();
    if (discarded) logger.info('Discarded segment', { conversationId, segmentId });
    return discarded;
  }

  /**
   * Mark a segment as ended.
   */
  endSegment(segmentId: string, status: 'completed' | 'failed' = 'completed'): void {
    const now = new Date().toISOString();
    this.stmts.endSegment.run(now, status, segmentId);
    logger.debug('Ended segment', { segmentId, status });
  }

  /**
   * Update the streaming ID on a segment (e.g., on resume) and reactivate it.
   */
  updateSegmentStreamingId(segmentId: string, streamingId: string): void {
    this.db.prepare(
      "UPDATE conversation_segments SET streaming_id = ?, status = 'active', ended_at = NULL WHERE segment_id = ?"
    ).run(streamingId, segmentId);
  }

  /**
   * Update the provider session ID on the latest segment of a conversation.
   * Called when run:ready reports the actual Claude session UUID, replacing
   * the pending-* placeholder created at conversation start.
   * Returns true if a pending- segment was updated.
   */
  updateSegmentProviderSessionId(conversationId: string, providerSessionId: string): boolean {
    const result = this.db.prepare(
      `UPDATE conversation_segments
       SET provider_session_id = ?
       WHERE conversation_id = ?
         AND provider_session_id LIKE 'pending-%'`
    ).run(providerSessionId, conversationId);
    return result.changes > 0;
  }

  /**
   * Update the model on the latest segment of a conversation.
   * Called when run:ready reports the configured model, so mid-session model
   * switches (harness respawn-with-resume) persist — otherwise a later
   * lifecycle resume would silently revert to the segment's creation-time
   * model via resolveResumeModel. Returns true if the stored model changed.
   */
  updateLatestSegmentModel(conversationId: string, model: string): boolean {
    const result = this.db.prepare(
      `UPDATE conversation_segments
       SET model = ?
       WHERE segment_id = (
         SELECT segment_id FROM conversation_segments
         WHERE conversation_id = ?
         ORDER BY sequence_number DESC
         LIMIT 1
       )
         AND (model IS NULL OR model != ?)`
    ).run(model, conversationId, model);
    return result.changes > 0;
  }

  /**
   * Record the reasoning effort a Codex thread or turn was actually started
   * with, on the latest segment. Called from the applied-setting callback, not
   * when an effort is merely queued or requested — the point of the column is
   * that it answers "what is this conversation running at", which only an
   * applied setting can. Returns true if the stored effort changed.
   */
  updateLatestSegmentReasoningEffort(conversationId: string, reasoningEffort: string): boolean {
    const result = this.db.prepare(
      `UPDATE conversation_segments
       SET reasoning_effort = ?
       WHERE segment_id = (
         SELECT segment_id FROM conversation_segments
         WHERE conversation_id = ?
         ORDER BY sequence_number DESC
         LIMIT 1
       )
         AND (reasoning_effort IS NULL OR reasoning_effort != ?)`
    ).run(reasoningEffort, conversationId, reasoningEffort);
    return result.changes > 0;
  }

  /**
   * Touch the conversation's updated_at timestamp.
   */
  touchConversation(conversationId: string): void {
    this.stmts.updateConversationTimestamp.run(new Date().toISOString(), conversationId);
  }

  // --- Queries ---

  /**
   * Get a conversation with all its segments.
   */
  /** Whether the conversation was created hidden: a fixture, never meant to be seen. */
  /** The Codex service tier this conversation was created on, or null for the default tier. */
  getServiceTier(conversationId: string): string | null {
    const row = this.db.prepare('SELECT service_tier FROM conversations WHERE conversation_id = ?')
      .get(conversationId) as { service_tier: string | null } | undefined;
    return row?.service_tier ?? null;
  }

  wasCreatedHidden(conversationId: string): boolean {
    return this.stmts.getCreatedHidden.get(conversationId, conversationId) !== undefined;
  }

  getConversation(conversationId: string): Conversation | null {
    const row = this.stmts.getConversation.get(conversationId) as ConversationRow | undefined;
    if (!row) return null;

    const segmentRows = this.stmts.getSegments.all(conversationId) as SegmentRow[];

    return {
      conversationId: row.conversation_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastActivityAt: resolveLastActivityAt(row),
      workingDirectory: row.working_directory,
      workspace: row.workspace,
      latestProvider: row.latest_provider as Provider | null,
      latestSegmentId: row.latest_segment_id,
      initialPrompt: row.initial_prompt,
      pickedUpFrom: row.picked_up_from ?? null,
      coordinator: row.coordinator === 1,
      segments: segmentRows.map(this.mapSegmentRow),
    };
  }

  /**
   * Validate a conversation's segment topology for structural anomalies.
   * Checks invariants that ConversationService's data model should enforce:
   * unique sequence numbers, consistent latestSegmentId, at most one active segment.
   */
  validateTopology(conversationId: string): {
    valid: boolean;
    anomalies: Array<{ type: string; detail: string }>;
    activeSegments: ConversationSegment[];
    expectedLatestSegmentId: string | null;
  } {
    const conversation = this.getConversation(conversationId);
    if (!conversation) {
      return { valid: false, anomalies: [{ type: 'not_found', detail: `Conversation ${conversationId} not found` }], activeSegments: [], expectedLatestSegmentId: null };
    }

    const anomalies: Array<{ type: string; detail: string }> = [];
    const segments = conversation.segments;

    // Check for duplicate sequence numbers
    const seqNumbers = segments.map(s => s.sequenceNumber);
    const seqUnique = new Set(seqNumbers);
    if (seqUnique.size !== seqNumbers.length) {
      anomalies.push({ type: 'duplicate_sequence_numbers', detail: `${seqNumbers.length - seqUnique.size} duplicate(s) in ${seqNumbers.length} segments` });
    }

    // Check latest segment consistency
    const maxSeq = seqNumbers.length > 0 ? Math.max(...seqNumbers) : null;
    const expectedLatestSegment = maxSeq !== null
      ? segments.find(s => s.sequenceNumber === maxSeq) ?? null
      : null;
    const expectedLatestSegmentId = expectedLatestSegment?.segmentId ?? null;

    if (expectedLatestSegment && conversation.latestSegmentId && conversation.latestSegmentId !== expectedLatestSegment.segmentId) {
      anomalies.push({
        type: 'latest_segment_mismatch',
        detail: `latestSegmentId=${conversation.latestSegmentId} but highest sequence segment is ${expectedLatestSegment.segmentId}`,
      });
    }

    // Check for multiple active segments
    const activeSegments = segments.filter(s => s.status === 'active');
    if (activeSegments.length > 1) {
      anomalies.push({
        type: 'multiple_active_segments',
        detail: `${activeSegments.length} segments have status=active`,
      });
    }

    return {
      valid: anomalies.length === 0,
      anomalies,
      activeSegments,
      expectedLatestSegmentId,
    };
  }

  /**
   * Get the latest segment for a conversation.
   */
  getLatestSegment(conversationId: string): ConversationSegment | null {
    const row = this.stmts.getLatestSegment.get(conversationId) as SegmentRow | undefined;
    return row ? this.mapSegmentRow(row) : null;
  }

  /**
   * Reverse lookup: given a provider session ID, find its conversation.
   */
  getConversationByProviderSession(providerSessionId: string): { conversation: Conversation; matchedSegmentId: string } | null {
    const row = this.stmts.getConversationByProviderSession.get(providerSessionId) as (ConversationRow & { matched_segment_id: string; matched_provider: string }) | undefined;
    if (!row) return null;

    const conversation = this.getConversation(row.conversation_id);
    if (!conversation) return null;

    return { conversation, matchedSegmentId: row.matched_segment_id };
  }

  /**
   * List conversations for sidebar.
   */
  listConversations(options?: { limit?: number; offset?: number; archived?: boolean }): { conversations: Conversation[]; total: number } {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    // When filtering to non-archived, use the JOIN query to exclude archived at the DB level.
    // This prevents test-created and orphaned conversations from polluting results.
    // archived: true used to fall through to the all-conversations query, so the
    // Archived list was "archived rows among the 200 most recently active",
    // re-sorted client-side by creation time.
    const [listStmt, countStmt] = options?.archived === false
      ? [this.stmts.listNonArchivedConversations, this.stmts.countNonArchivedConversations]
      : options?.archived === true
        ? [this.stmts.listArchivedConversations, this.stmts.countArchivedConversations]
        : [this.stmts.listConversations, this.stmts.countConversations];
    const rows = listStmt.all(limit, offset) as ConversationRow[];
    const { count } = countStmt.get() as { count: number };

    const conversations = rows.map(row => {
      const segmentRows = this.stmts.getSegments.all(row.conversation_id) as SegmentRow[];
      return {
        conversationId: row.conversation_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastActivityAt: resolveLastActivityAt(row),
        archivedAt: row.archived_at ?? null,
        workingDirectory: row.working_directory,
        workspace: row.workspace,
        latestProvider: row.latest_provider as Provider | null,
        latestSegmentId: row.latest_segment_id,
        initialPrompt: row.initial_prompt,
        pickedUpFrom: row.picked_up_from ?? null,
        coordinator: row.coordinator === 1,
        segments: segmentRows.map(this.mapSegmentRow),
      };
    });

    return { conversations, total: count };
  }

  /**
   * Update the initial_prompt for a conversation.
   */
  updateInitialPrompt(conversationId: string, prompt: string): void {
    this.db.prepare('UPDATE conversations SET initial_prompt = ? WHERE conversation_id = ?').run(prompt, conversationId);
  }

  /**
   * Get conversations with null initial_prompt (for backfill).
   * Returns conversationId + first segment's providerSessionId.
   */
  getConversationsMissingPrompt(): Array<{ conversationId: string; providerSessionId: string }> {
    const rows = this.db.prepare(`
      SELECT c.conversation_id, cs.provider_session_id
      FROM conversations c
      JOIN conversation_segments cs ON cs.conversation_id = c.conversation_id AND cs.sequence_number = 1
      WHERE c.initial_prompt IS NULL
    `).all() as Array<{ conversation_id: string; provider_session_id: string }>;
    return rows.map(r => ({ conversationId: r.conversation_id, providerSessionId: r.provider_session_id }));
  }

  // --- Legacy adoption ---

  /**
   * Wrap an existing legacy session (Claude UUID or codex-* ID) into a conversation.
   * Returns the new conversation ID, or the existing one if already adopted.
   */
  adoptLegacySession(sessionId: string, params: {
    provider: Provider;
    workingDirectory: string;
    workspace?: string;
  }): { conversationId: string; created: boolean } {
    // Check if already adopted
    const existing = this.getConversationByProviderSession(sessionId);
    if (existing) {
      return { conversationId: existing.conversation.conversationId, created: false };
    }

    const { conversationId } = this.createConversation({
      workingDirectory: params.workingDirectory,
      provider: params.provider,
      providerSessionId: sessionId,
      workspace: params.workspace,
    });

    return { conversationId, created: true };
  }

  // --- Helpers ---

  private mapSegmentRow(row: SegmentRow): ConversationSegment {
    return {
      segmentId: row.segment_id,
      conversationId: row.conversation_id,
      provider: row.provider as Provider,
      providerSessionId: row.provider_session_id,
      sequenceNumber: row.sequence_number,
      createdAt: row.created_at,
      endedAt: row.ended_at,
      status: row.status as SegmentStatus,
      model: row.model,
      reasoningEffort: row.reasoning_effort ?? null,
      streamingId: row.streaming_id,
    };
  }
}
