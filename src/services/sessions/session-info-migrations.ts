import Database from 'better-sqlite3';
import type { Logger } from '../infrastructure/logger.js';
import { ensureHarnessEventsSchema } from '../../harness/sqlite-event-storage.js';

export function runSessionInfoSchemaBootstrap(
  db: Database.Database,
  logger: Logger,
): void {
  const runner = new SessionInfoSchemaBootstrapRunner(db, logger);
  runner.run();
}

class SessionInfoSchemaBootstrapRunner {
  constructor(
    private readonly db: Database.Database,
    private readonly logger: Logger,
  ) {}

  run(): void {
    // Must come first: ConversationService prepares statements referencing
    // harness_events, and it is constructed well before the harness sets up its
    // storage adapter — prepare() on a missing table throws and takes the
    // server down on a fresh install. Idempotent; the DDL is owned by
    // sqlite-event-storage.
    ensureHarnessEventsSchema(this.db);
    this.ensureCoreSchema();
    this.runSchemaMigrations();
  }

  private ensureCoreSchema(): void {
    this.createSessionsAndMetadataSchema();
    this.createInsightsAndTurnsSchema();
    this.createRecommendationsAndMarksSchema();
    this.createAnalysisAndEventsSchema();
    this.createContextTransfersAndQueueSchema();
    this.createKnowledgeMapSchema();
  }

  private createSessionsAndMetadataSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        custom_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        continuation_session_id TEXT NOT NULL DEFAULT '',
        initial_commit_head TEXT NOT NULL DEFAULT '',
        permission_mode TEXT NOT NULL DEFAULT 'default'
      );
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private createInsightsAndTurnsSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_insights (
        session_id TEXT PRIMARY KEY,
        context TEXT DEFAULT NULL,
        tags TEXT DEFAULT NULL,
        theme TEXT,
        computed_at TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER DEFAULT NULL,
        patched_at TEXT DEFAULT NULL,
        purpose TEXT DEFAULT NULL,
        lines_added INTEGER DEFAULT 0,
        lines_removed INTEGER DEFAULT 0,
        edit_count INTEGER DEFAULT 0,
        write_count INTEGER DEFAULT 0,
        metrics_updated_at TEXT DEFAULT NULL
      );
      CREATE TABLE IF NOT EXISTS session_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_number INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        headline TEXT NOT NULL,
        actions TEXT NOT NULL DEFAULT '[]',
        tag TEXT NOT NULL,
        icon TEXT NOT NULL,
        exit_code INTEGER,
        termination_reason TEXT NOT NULL DEFAULT 'normal_completion',
        tool_count INTEGER NOT NULL DEFAULT 0,
        incomplete INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_turns_session_id ON session_turns(session_id);
      CREATE INDEX IF NOT EXISTS idx_turns_timestamp ON session_turns(timestamp);
    `);
  }

  private createRecommendationsAndMarksSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recommendations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        category TEXT NOT NULL,
        friction TEXT NOT NULL,
        suggestion TEXT NOT NULL,
        why TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        actioned_at TEXT,
        project_path TEXT,
        user_note TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_recommendations_session_id ON recommendations(session_id);
      CREATE INDEX IF NOT EXISTS idx_recommendations_status ON recommendations(status);

      CREATE TABLE IF NOT EXISTS friction_marks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        content_type TEXT NOT NULL,
        tool_name TEXT,
        content_preview TEXT NOT NULL,
        full_content TEXT NOT NULL,
        marked_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_friction_marks_session ON friction_marks(session_id);

      -- Session marks v2: supports multiple mark types with turn context
      CREATE TABLE IF NOT EXISTS session_marks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        mark_type TEXT NOT NULL DEFAULT 'friction',
        content_type TEXT NOT NULL,
        tool_name TEXT,
        content_preview TEXT NOT NULL,
        turn_number INTEGER,
        turn_context TEXT,
        marked_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_marks_session ON session_marks(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_marks_type ON session_marks(mark_type);

      -- File changes captured from Edit/Write tool calls for walkthrough generation
      CREATE TABLE IF NOT EXISTS turn_file_changes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_number INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        old_string TEXT,
        new_string TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_turn_file_changes_session ON turn_file_changes(session_id);
      CREATE INDEX IF NOT EXISTS idx_turn_file_changes_file ON turn_file_changes(file_path);
    `);
  }

  private createAnalysisAndEventsSchema(): void {
    this.db.exec(`
      -- Walkthrough scope analysis cache
      CREATE TABLE IF NOT EXISTS walkthrough_scope_cache (
        session_id TEXT PRIMARY KEY,
        turn_count INTEGER NOT NULL,
        generated_at TEXT NOT NULL,
        analysis_json TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );

      -- Session review analysis cache (post-session review with narrative + recommendations)
      CREATE TABLE IF NOT EXISTS review_analysis_cache (
        session_id TEXT PRIMARY KEY,
        turn_count INTEGER NOT NULL,
        generated_at TEXT NOT NULL,
        analysis_json TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );

      -- Session events: structured, chronological observability (assistant-first debugging)
      CREATE TABLE IF NOT EXISTS session_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        trace_id TEXT,
        event_type TEXT NOT NULL,
        provider TEXT,
        streaming_id TEXT,
        thread_id TEXT,
        message_id TEXT,
        timestamp TEXT NOT NULL,
        source TEXT NOT NULL,
        metadata_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_events_trace ON session_events(trace_id);
      CREATE INDEX IF NOT EXISTS idx_session_events_time ON session_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(event_type);

      -- Cross-session extraction cache and synthesis output
      CREATE TABLE IF NOT EXISTS session_extractions (
        session_id TEXT PRIMARY KEY,
        conversation_id TEXT,
        extraction_json TEXT,
        provider TEXT NOT NULL,
        gate_result TEXT NOT NULL,
        gate_reason TEXT,
        project_path TEXT,
        created_at TEXT NOT NULL,
        token_count INTEGER,
        cost REAL,
        included_in_synthesis TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_session_extractions_gate_pending
        ON session_extractions(gate_result, included_in_synthesis, created_at);
      CREATE INDEX IF NOT EXISTS idx_session_extractions_conversation_id
        ON session_extractions(conversation_id);

      CREATE TABLE IF NOT EXISTS cross_session_syntheses (
        id TEXT PRIMARY KEY,
        extraction_ids TEXT NOT NULL,
        extraction_count INTEGER NOT NULL DEFAULT 0,
        synthesis_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        claude_md_snapshot TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        cost REAL
      );
      CREATE INDEX IF NOT EXISTS idx_cross_session_syntheses_status
        ON cross_session_syntheses(status, created_at);

      -- Session summaries: per-session digest used to inject a "what other
      -- sessions have done" index into future session system prompts. See
      -- session-summary-service.ts. Provenance fields (generator_version /
      -- generator_model / generated_at) make it possible to audit when a
      -- summary feels off.
      CREATE TABLE IF NOT EXISTS session_summaries (
        session_id TEXT PRIMARY KEY,
        project TEXT,
        title TEXT,
        summary TEXT,
        notable TEXT,
        tags TEXT,                              -- JSON array of strings
        files_touched TEXT,                     -- JSON array of strings
        event_count INTEGER,
        started_at TEXT,
        ended_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending', -- pending | generating | complete | failed
        error_message TEXT,
        generator_version TEXT,
        generator_model TEXT,
        generated_at TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_summaries_project
        ON session_summaries(project);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_generated_at
        ON session_summaries(generated_at);
    `);
  }

  private createContextTransfersAndQueueSchema(): void {
    this.db.exec(`
      -- Context transfer audit: tracks when context is passed between providers
      CREATE TABLE IF NOT EXISTS context_transfers (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        from_provider TEXT NOT NULL,
        to_provider TEXT NOT NULL,
        transferred_at TEXT NOT NULL,
        source_message_count INTEGER NOT NULL,
        source_first_message_id TEXT,
        source_last_message_id TEXT,
        context_preview TEXT,
        context_char_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_context_transfers_conversation ON context_transfers(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_context_transfers_time ON context_transfers(transferred_at);

      -- Dev notes: quick issue/todo capture queue (session-independent)
      CREATE TABLE IF NOT EXISTS dev_notes (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        status TEXT NOT NULL DEFAULT 'pending',
        project_path TEXT,
        created_at TEXT NOT NULL,
        actioned_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_dev_notes_status ON dev_notes(status);
      CREATE INDEX IF NOT EXISTS idx_dev_notes_created ON dev_notes(created_at);

      -- Session inbox: what arrived while the session could not read it. A
      -- user's message to a mid-turn Codex process (parked in adapter memory
      -- otherwise, and lost on restart), or a worker's report or question for
      -- the coordinator it was picked up from (only handed over between the
      -- coordinator's turns). Drained into one turn when the session is idle;
      -- read_at is null until that turn took the row. attempts counts
      -- drains that reached the send, so a row still unread after a restart
      -- can be flagged as possibly seen. reply is the fast responder's
      -- provisional answer to a user item (services/sessions/coordinator-fast-reply.ts);
      -- reply_pending holds the row out of the drain while that answer is
      -- being written. sender is the conversation that declared itself the
      -- author (session send --from), null when none did; passed_on is the
      -- sender's declaration that the text relays the user's decision; source_seq
      -- is the event in this session's log the item was made from (the
      -- worker:asked / worker:reported / coordination:review event); delivery_id
      -- is a caller-chosen key so re-enqueueing the same delivery is a no-op.
      -- answers_id, on a quick-answer row, is the row it answers.
      -- reserved_by holds the batch id of a delivery in flight: a reserved
      -- row is out of the ordinary drain, which is what stops a turn ending
      -- mid-handover from sending it a second time. reservation_state says
      -- how far that delivery got ('reserved', 'handed', 'accepted',
      -- 'uncertain'), which is what a restart reads to tell a delivery that
      -- definitely never left from one that may already have reached the
      -- model. after_turn is 1 when the sender asked for the item to wait for
      -- the turn to end; a delivery into a running turn leaves it behind.
      -- See services/sessions/session-inbox.ts and services/sessions/immediate-delivery.ts.
      CREATE TABLE IF NOT EXISTS session_inbox (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL,
        text TEXT NOT NULL,
        worker TEXT,
        worker_model TEXT,
        attachments_json TEXT,
        model TEXT,
        reasoning_effort TEXT,
        created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        read_at TEXT,
        read_seq INTEGER,
        reply TEXT,
        reply_pending INTEGER NOT NULL DEFAULT 0,
        sender TEXT,
        passed_on INTEGER NOT NULL DEFAULT 0,
        source_seq INTEGER,
        delivery_id TEXT,
        answers_id TEXT,
        reserved_by TEXT,
        reserved_at TEXT,
        reservation_state TEXT,
        after_turn INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_session_inbox_session_unread
        ON session_inbox(session_id, read_at, created_at);

      -- One line per worker saying what it is doing now, for its card in the
      -- coordinator's panel ("Testing the composer"). Written by a model from
      -- the worker's own work evidence; see services/sessions/worker-activity.ts.
      -- turn_seq is the input:sent the phrase describes work on and evidence_seq
      -- the last event that gave the writer anything to say: the first retires
      -- the phrase when the turn ends, the second stops a worker that has only
      -- thought since being described again. One row per worker, replaced in place.
      CREATE TABLE IF NOT EXISTS worker_activity (
        worker TEXT PRIMARY KEY,
        coordinator TEXT NOT NULL,
        text TEXT NOT NULL,
        turn_seq INTEGER NOT NULL,
        evidence_seq INTEGER NOT NULL,
        model TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_worker_activity_coordinator
        ON worker_activity(coordinator);
    `);
  }

  /**
   * Learning map ("km" = knowledge map): typed article nodes that any session
   * can write to over HTTP as a reply medium. See docs/learning-map-api.md.
   *
   * Timestamps here are INTEGER epoch milliseconds rather than the ISO TEXT
   * used by the older session tables — these rows are read by a graph UI that
   * sorts and diffs them numerically.
   *
   * The FOREIGN KEY clauses are declarative only: this database never turns on
   * `PRAGMA foreign_keys`, so KnowledgeMapService checks parent rows in code
   * and the routes answer 404 rather than relying on the engine to reject.
   */
  private createKnowledgeMapSchema(): void {
    this.db.exec(`
      -- default_conv is the conversation that answers inline highlight→ask
      -- questions for articles that carry no provenance of their own. Nullable:
      -- a map has none until the first ask on a provenance-less article creates
      -- one. See docs/learning-map-api.md.
      CREATE TABLE IF NOT EXISTS km_maps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        default_conv TEXT,
        created_at INTEGER NOT NULL
      );

      -- Article nodes. node_type is validated in code against KM_NODE_TYPES and
      -- stored as plain TEXT so new node kinds do not need a schema change.
      CREATE TABLE IF NOT EXISTS km_articles (
        id TEXT PRIMARY KEY,
        map_id TEXT NOT NULL,
        title TEXT NOT NULL,
        content_md TEXT NOT NULL,
        -- Shown on the map node itself: a sentence or two, plus short bullets
        -- stored as a JSON array. A node without them falls back to its title.
        summary TEXT,
        takeaways TEXT,
        -- Hover explanations for the article's bold terms, as a JSON object
        -- keyed by the bold text. Generated on demand; NULL until then.
        tooltips TEXT,
        node_type TEXT NOT NULL DEFAULT 'article',
        created_from TEXT,
        created_by_conv TEXT,
        pinned_x REAL,
        pinned_y REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (map_id) REFERENCES km_maps(id)
      );
      CREATE INDEX IF NOT EXISTS idx_km_articles_map ON km_articles(map_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_km_articles_conv ON km_articles(created_by_conv);

      -- A trail through the map, not a diagram of it: an edge is the question
      -- that took the reader from one article to the next, and label is that
      -- question's text. NULL on a related link, which nobody asked for.
      CREATE TABLE IF NOT EXISTS km_edges (
        id TEXT PRIMARY KEY,
        map_id TEXT NOT NULL,
        from_article_id TEXT NOT NULL,
        to_article_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (map_id) REFERENCES km_maps(id),
        FOREIGN KEY (from_article_id) REFERENCES km_articles(id),
        FOREIGN KEY (to_article_id) REFERENCES km_articles(id)
      );
      CREATE INDEX IF NOT EXISTS idx_km_edges_map ON km_edges(map_id, created_at);

      -- Marginalia: a highlighted span inside an article plus the question asked
      -- about it. answer_md stays NULL until the answering session fills it in.
      CREATE TABLE IF NOT EXISTS km_exchanges (
        id TEXT PRIMARY KEY,
        article_id TEXT NOT NULL,
        quote TEXT NOT NULL,
        quote_start INTEGER,
        question TEXT NOT NULL,
        answer_md TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (article_id) REFERENCES km_articles(id)
      );
      CREATE INDEX IF NOT EXISTS idx_km_exchanges_article ON km_exchanges(article_id, created_at);
    `);
  }

  private runSchemaMigrations(): void {
    // Migration: add columns/indexes for existing databases.
    this.migrateSessionsColumns();
    this.migrateInsightsColumns();
    this.migrateTurnTags();
    this.migrateTurnsColumns();
    this.migrateToSessionMarks();
    this.migrateRecommendationsColumns();
    this.migrateQueuesToInbox();
    this.migrateInboxReplyColumns();
    this.migrateInboxProvenanceColumns();
    this.migrateInboxReservationColumns();
    this.migrateKmMapsDefaultConvColumn();
    this.migrateKmArticlesNodeContentColumns();
    this.migrateKmEdgesLabelColumn();
    this.consolidateConversationInsightsRows();
  }

  /**
   * Migration: add default_conv to km_maps for databases created before the
   * inline highlight→ask flow needed a fallback responder session.
   */
  private migrateKmMapsDefaultConvColumn(): void {
    try {
      const tableInfo = this.db.pragma('table_info(km_maps)') as Array<{ name: string }>;
      const columnNames = tableInfo.map(col => col.name);
      if (columnNames.length > 0 && !columnNames.includes('default_conv')) {
        this.db.exec('ALTER TABLE km_maps ADD COLUMN default_conv TEXT');
        this.logger.debug('Added default_conv column to km_maps');
      }
    } catch (error) {
      this.logger.debug('km_maps default_conv migration check failed', { error });
    }
  }

  /**
   * Migration: add summary/takeaways/tooltips to km_articles for databases
   * created before map nodes showed a summary and bullets rather than a bare
   * title, and before bold terms in an article carried hover explanations.
   */
  private migrateKmArticlesNodeContentColumns(): void {
    try {
      const tableInfo = this.db.pragma('table_info(km_articles)') as Array<{ name: string }>;
      const columnNames = tableInfo.map(col => col.name);
      if (columnNames.length === 0) return;
      if (!columnNames.includes('summary')) {
        this.db.exec('ALTER TABLE km_articles ADD COLUMN summary TEXT');
        this.logger.debug('Added summary column to km_articles');
      }
      if (!columnNames.includes('takeaways')) {
        this.db.exec('ALTER TABLE km_articles ADD COLUMN takeaways TEXT');
        this.logger.debug('Added takeaways column to km_articles');
      }
      if (!columnNames.includes('tooltips')) {
        this.db.exec('ALTER TABLE km_articles ADD COLUMN tooltips TEXT');
        this.logger.debug('Added tooltips column to km_articles');
      }
    } catch (error) {
      this.logger.debug('km_articles node-content migration check failed', { error });
    }
  }

  /**
   * Migration: add label to km_edges for databases created before an edge
   * carried the question that produced it.
   */
  private migrateKmEdgesLabelColumn(): void {
    try {
      const tableInfo = this.db.pragma('table_info(km_edges)') as Array<{ name: string }>;
      const columnNames = tableInfo.map(col => col.name);
      if (columnNames.length > 0 && !columnNames.includes('label')) {
        this.db.exec('ALTER TABLE km_edges ADD COLUMN label TEXT');
        this.logger.debug('Added label column to km_edges');
      }
    } catch (error) {
      this.logger.debug('km_edges label migration check failed', { error });
    }
  }

  private migrateSessionsColumns(): void {
    // Check if new columns exist on sessions table and add them if not.
    try {
      const tableInfo = this.db.pragma('table_info(sessions)') as Array<{ name: string }>;
      const columnNames = tableInfo.map(col => col.name);
      this.migrateSessionIdentityColumns(columnNames);
      this.migrateSessionBranchColumns(columnNames);
      this.migrateSessionWorkspaceColumns(columnNames);
      this.migrateSessionTeamColumns(columnNames);
      this.migrateSessionMcpServersColumn(columnNames);
      this.migrateSessionConversationMapping(columnNames);
      this.migrateSessionImportedAtColumn(columnNames);
      this.migrateSessionUsageColumn(columnNames);
      this.migrateSessionCreatedHiddenColumn(columnNames);
      this.migrateSessionProjectNameColumn(columnNames);
      this.migrateSessionArchivedAtColumn(columnNames);
      // Covering index for archived filter — the sessions table contains large
      // identity_image blobs, so a full scan for WHERE archived = 0 is very slow.
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(archived, session_id)');
    } catch (error) {
      this.logger.debug('Sessions migration check failed', { error });
    }
  }

  /**
   * Whether a session was hidden the moment it existed (1) or created in the
   * open (0). `archived` alone cannot say: a verification fixture created
   * `--archived` and a worker archived once it finished are the same row.
   *
   * Existing rows stay NULL, meaning nobody recorded it. Nothing infers a
   * value for them from names, timestamps or their parent — an unarchive is
   * the only thing that resolves one, and only because someone asked for it.
   */
  private migrateSessionCreatedHiddenColumn(columnNames: string[]): void {
    this.addSessionsColumnIfMissing(
      columnNames,
      'created_hidden',
      'ALTER TABLE sessions ADD COLUMN created_hidden INTEGER DEFAULT NULL'
    );
  }

  /**
   * A coordinator's generated project title. Deliberately its own column
   * rather than a value written into `custom_name`: a name the user typed and
   * a name the server generated answer to different rules, and keeping them
   * apart is what makes it impossible for a generation that finishes late to
   * land on top of a rename the user made while it was in flight.
   *
   * NULL on every existing row and on every non-coordinator session, which is
   * the normal case — the reader falls back to the session mission.
   */
  private migrateSessionProjectNameColumn(columnNames: string[]): void {
    this.addSessionsColumnIfMissing(
      columnNames,
      'project_name',
      'ALTER TABLE sessions ADD COLUMN project_name TEXT DEFAULT NULL'
    );
  }

  /**
   * When a session was last archived, so the Archived list can put the one
   * just archived first. A trigger stamps it on every 0 -> 1 flip and clears
   * it on unarchive: sessions are archived from the conversation header, the
   * CLI, archive-all and the auto-archive sweep, and a trigger covers them
   * all without each writer having to remember.
   *
   * NULL on rows archived before this column existed; nothing guesses a time
   * for them. They sort after every stamped row, by last activity.
   */
  private migrateSessionArchivedAtColumn(columnNames: string[]): void {
    this.addSessionsColumnIfMissing(
      columnNames,
      'archived_at',
      'ALTER TABLE sessions ADD COLUMN archived_at TEXT DEFAULT NULL'
    );
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS sessions_archived_at_set
      AFTER UPDATE OF archived ON sessions
      WHEN old.archived = 0 AND new.archived = 1
      BEGIN
        UPDATE sessions SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE session_id = new.session_id;
      END;
      CREATE TRIGGER IF NOT EXISTS sessions_archived_at_clear
      AFTER UPDATE OF archived ON sessions
      WHEN old.archived = 1 AND new.archived = 0
      BEGIN
        UPDATE sessions SET archived_at = NULL WHERE session_id = new.session_id;
      END;
    `);
  }

  private migrateSessionImportedAtColumn(columnNames: string[]): void {
    this.addSessionsColumnIfMissing(
      columnNames,
      'imported_at',
      'ALTER TABLE sessions ADD COLUMN imported_at TEXT DEFAULT NULL'
    );
  }

  private migrateSessionIdentityColumns(columnNames: string[]): void {
    this.addSessionsColumnIfMissing(
      columnNames,
      'identity_image',
      'ALTER TABLE sessions ADD COLUMN identity_image TEXT DEFAULT NULL'
    );
    this.addSessionsColumnIfMissing(
      columnNames,
      'last_termination_reason',
      'ALTER TABLE sessions ADD COLUMN last_termination_reason TEXT DEFAULT NULL'
    );
    this.addSessionsColumnIfMissing(
      columnNames,
      'pin_character_name',
      'ALTER TABLE sessions ADD COLUMN pin_character_name TEXT DEFAULT NULL'
    );
    this.addSessionsColumnIfMissing(
      columnNames,
      'pin_character_image',
      'ALTER TABLE sessions ADD COLUMN pin_character_image TEXT DEFAULT NULL'
    );
  }

  private migrateSessionBranchColumns(columnNames: string[]): void {
    this.addSessionsColumnIfMissing(
      columnNames,
      'branched_from_session_id',
      'ALTER TABLE sessions ADD COLUMN branched_from_session_id TEXT DEFAULT NULL'
    );
    this.addSessionsColumnIfMissing(
      columnNames,
      'branched_at_turn',
      'ALTER TABLE sessions ADD COLUMN branched_at_turn INTEGER DEFAULT NULL'
    );
  }

  private migrateSessionWorkspaceColumns(columnNames: string[]): void {
    // Workspace column - sessions belong to a workspace (default 'main').
    this.addSessionsColumnIfMissing(
      columnNames,
      'workspace',
      "ALTER TABLE sessions ADD COLUMN workspace TEXT NOT NULL DEFAULT 'main'"
    );
    // Proposed next steps - stored as JSON, displayed as clickable pills.
    this.addSessionsColumnIfMissing(
      columnNames,
      'proposed_next_steps',
      'ALTER TABLE sessions ADD COLUMN proposed_next_steps TEXT DEFAULT NULL'
    );
  }

  private migrateSessionTeamColumns(columnNames: string[]): void {
    this.addSessionsColumnIfMissing(
      columnNames,
      'team_name',
      'ALTER TABLE sessions ADD COLUMN team_name TEXT DEFAULT NULL'
    );
    this.addSessionsColumnIfMissing(
      columnNames,
      'team_role',
      'ALTER TABLE sessions ADD COLUMN team_role TEXT DEFAULT NULL'
    );
    // Session pause feature.
    this.addSessionsColumnIfMissing(
      columnNames,
      'paused_reason',
      'ALTER TABLE sessions ADD COLUMN paused_reason TEXT DEFAULT NULL'
    );
  }

  private migrateSessionMcpServersColumn(columnNames: string[]): void {
    this.addSessionsColumnIfMissing(
      columnNames,
      'mcp_servers',
      'ALTER TABLE sessions ADD COLUMN mcp_servers TEXT DEFAULT NULL'
    );
  }

  private migrateSessionUsageColumn(columnNames: string[]): void {
    this.addSessionsColumnIfMissing(
      columnNames,
      'last_turn_usage_json',
      'ALTER TABLE sessions ADD COLUMN last_turn_usage_json TEXT DEFAULT NULL'
    );
  }

  private migrateSessionConversationMapping(columnNames: string[]): void {
    if (columnNames.includes('conversation_id')) {
      return;
    }

    this.db.exec('ALTER TABLE sessions ADD COLUMN conversation_id TEXT DEFAULT NULL');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_conversation ON sessions(conversation_id)');
    this.logger.info('Added conversation_id column to sessions');
  }

  private addSessionsColumnIfMissing(columnNames: string[], columnName: string, sql: string): void {
    if (columnNames.includes(columnName)) {
      return;
    }

    this.db.exec(sql);
    this.logger.info(`Added ${columnName} column to sessions`);
  }

  private migrateInsightsColumns(): void {
    // Check if new columns exist and add them if not.
    try {
      const tableInfo = this.db.pragma('table_info(session_insights)') as Array<{ name: string }>;
      const columnNames = tableInfo.map(col => col.name);
      this.migrateInsightsOntologyColumns(columnNames);
      this.migrateInsightsDeltaColumns(columnNames);
      this.migrateInsightsV9Columns(columnNames);
      this.migrateInsightsCategoryColumns(columnNames);
      this.migrateInsightsToolMetricColumns(columnNames);
      this.pruneObsoleteInsightsColumns(columnNames);
    } catch (error) {
      this.logger.debug('Migration check failed (table may not exist yet)', { error });
    }
  }

  private migrateInsightsOntologyColumns(columnNames: string[]): void {
    this.addInsightsColumnIfMissing(
      columnNames,
      'context',
      "ALTER TABLE session_insights ADD COLUMN context TEXT DEFAULT NULL"
    );
    this.addInsightsColumnIfMissing(
      columnNames,
      'tags',
      "ALTER TABLE session_insights ADD COLUMN tags TEXT DEFAULT NULL"
    );
  }

  private migrateInsightsDeltaColumns(columnNames: string[]): void {
    this.addInsightsColumnIfMissing(
      columnNames,
      'message_count',
      "ALTER TABLE session_insights ADD COLUMN message_count INTEGER DEFAULT NULL"
    );
    this.addInsightsColumnIfMissing(
      columnNames,
      'patched_at',
      "ALTER TABLE session_insights ADD COLUMN patched_at TEXT DEFAULT NULL"
    );
  }

  private migrateInsightsV9Columns(columnNames: string[]): void {
    this.addInsightsColumnIfMissing(
      columnNames,
      'purpose',
      "ALTER TABLE session_insights ADD COLUMN purpose TEXT DEFAULT NULL"
    );
  }

  private migrateInsightsCategoryColumns(columnNames: string[]): void {
    // Closed-enum work-type classification: JSON {"primary": "...", "secondary": [...]}
    this.addInsightsColumnIfMissing(
      columnNames,
      'categories',
      "ALTER TABLE session_insights ADD COLUMN categories TEXT DEFAULT NULL"
    );
  }

  private migrateInsightsToolMetricColumns(columnNames: string[]): void {
    // Tool metrics columns (Phase 1 of list endpoint optimization).
    // These cache ToolMetrics to avoid re-parsing all messages on every list request.
    this.addInsightsColumnIfMissing(
      columnNames,
      'lines_added',
      'ALTER TABLE session_insights ADD COLUMN lines_added INTEGER DEFAULT 0'
    );
    this.addInsightsColumnIfMissing(
      columnNames,
      'lines_removed',
      'ALTER TABLE session_insights ADD COLUMN lines_removed INTEGER DEFAULT 0'
    );
    this.addInsightsColumnIfMissing(
      columnNames,
      'edit_count',
      'ALTER TABLE session_insights ADD COLUMN edit_count INTEGER DEFAULT 0'
    );
    this.addInsightsColumnIfMissing(
      columnNames,
      'write_count',
      'ALTER TABLE session_insights ADD COLUMN write_count INTEGER DEFAULT 0'
    );
    this.addInsightsColumnIfMissing(
      columnNames,
      'metrics_updated_at',
      'ALTER TABLE session_insights ADD COLUMN metrics_updated_at TEXT DEFAULT NULL'
    );
  }

  private addInsightsColumnIfMissing(columnNames: string[], columnName: string, sql: string): void {
    if (columnNames.includes(columnName)) {
      return;
    }

    this.db.exec(sql);
    this.logger.info(`Added ${columnName} column to session_insights`);
  }

  /**
   * Best-effort pruning of obsolete session_insights columns.
   * This is non-fatal and only attempts once per database.
   */
  private pruneObsoleteInsightsColumns(columnNames: string[]): void {
    const migrationKey = 'session_insights_columns_pruned_v1';
    const setMigrationStateStmt = this.db.prepare(
      'INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    );

    try {
      const migrationState = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(migrationKey) as { value?: string } | undefined;
      if (migrationState?.value === 'true' || migrationState?.value === 'unsupported') {
        return;
      }

      const obsoleteColumns = [
        'description',
        'milestones',
        'recent_actions',
        'notable',
        'panels',
        'current_state',
        'purposes',
        'progress_completed',
        'progress_total',
        'outstanding_tasks',
        'completed_tasks',
        'current_task',
        'progress_items',
        'notable_events',
        'recent_actions_v2',
        'progress_summary',
      ] as const;

      const columnsToDrop = obsoleteColumns.filter(col => columnNames.includes(col));
      if (columnsToDrop.length === 0) {
        setMigrationStateStmt.run(migrationKey, 'true');
        return;
      }

      const droppedColumns: string[] = [];
      for (const columnName of columnsToDrop) {
        try {
          this.db.exec(`ALTER TABLE session_insights DROP COLUMN "${columnName}"`);
          droppedColumns.push(columnName);
        } catch (error) {
          this.logger.warn('Obsolete insights column prune skipped (unsupported or blocked)', {
            columnName,
            error: error instanceof Error ? error.message : String(error),
          });
          setMigrationStateStmt.run(migrationKey, 'unsupported');
          return;
        }
      }

      setMigrationStateStmt.run(migrationKey, 'true');
      if (droppedColumns.length > 0) {
        this.logger.info('Pruned obsolete session_insights columns', {
          droppedCount: droppedColumns.length,
          droppedColumns,
        });
      }
    } catch (error) {
      this.logger.warn('Failed to prune obsolete session_insights columns', { error });
    }
  }

  /**
   * Clean turn tags that have trailing emojis from the Haiku bug.
   * Uses metadata key to ensure this only runs once per database.
   */
  private migrateTurnTags(): void {
    try {
      // Check if migration already ran
      const migrated = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('turn_tags_cleaned') as { value?: string } | undefined;
      if (migrated?.value === 'true') {
        return;
      }

      // Find all turns with emoji in tag field and clean them
      const turnsWithEmoji = this.db.prepare(`
        SELECT id, tag FROM session_turns
        WHERE tag LIKE '%🔍%' OR tag LIKE '%🔧%' OR tag LIKE '%💡%'
           OR tag LIKE '%🏗%' OR tag LIKE '%♻%' OR tag LIKE '%🐛%'
           OR tag LIKE '%💬%' OR tag LIKE '%⚖%' OR tag LIKE '%🔄%' OR tag LIKE '%🚧%'
      `).all() as Array<{ id: string; tag: string }>;

      if (turnsWithEmoji.length > 0) {
        const updateStmt = this.db.prepare('UPDATE session_turns SET tag = ? WHERE id = ?');

        // Same regex used in turn-capture-service.ts
        const emojiStrippingRegex = /[\p{Extended_Pictographic}\p{Variation_Selector}\s]+$/u;

        for (const turn of turnsWithEmoji) {
          const cleanTag = turn.tag.replace(emojiStrippingRegex, '').trim() || 'discuss';
          updateStmt.run(cleanTag, turn.id);
        }

        this.logger.info(`Cleaned ${turnsWithEmoji.length} turn tags with trailing emojis`);
      }

      // Mark migration as complete
      this.db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run('turn_tags_cleaned', 'true');
    } catch (error) {
      this.logger.debug('Turn tag migration failed', { error });
    }
  }

  private migrateTurnsColumns(): void {
    // Add termination_reason column to session_turns if it doesn't exist
    try {
      const tableInfo = this.db.pragma('table_info(session_turns)') as Array<{ name: string }>;
      const columnNames = tableInfo.map(col => col.name);

      if (!columnNames.includes('termination_reason')) {
        this.db.exec("ALTER TABLE session_turns ADD COLUMN termination_reason TEXT NOT NULL DEFAULT 'normal_completion'");
        this.logger.info('Added termination_reason column to session_turns');
      }
    } catch (error) {
      this.logger.debug('Session turns migration check failed', { error });
    }
  }

  /**
   * Migrate existing friction_marks to session_marks table.
   * Runs once, tracked via metadata key.
   */
  private migrateToSessionMarks(): void {
    try {
      // Check if migration already ran
      const migrated = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('session_marks_migrated') as { value?: string } | undefined;
      if (migrated?.value === 'true') {
        return;
      }

      // Check if there are existing friction_marks to migrate
      const count = this.db.prepare('SELECT COUNT(*) as count FROM friction_marks').get() as { count: number };

      if (count.count > 0) {
        this.logger.info('Migrating friction_marks to session_marks', { count: count.count });

        // Copy existing friction marks to new table with mark_type='friction'
        // Note: we don't have turn_context for old marks, they'll work with fallback display
        this.db.exec(`
          INSERT INTO session_marks (id, session_id, message_id, mark_type, content_type, tool_name, content_preview, turn_number, turn_context, marked_at)
          SELECT id, session_id, message_id, 'friction', content_type, tool_name, content_preview, NULL, NULL, marked_at
          FROM friction_marks
        `);

        this.logger.info('Migrated friction_marks to session_marks', { count: count.count });
      }

      // Mark migration as complete
      this.db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('session_marks_migrated', 'true');
      this.logger.info('Session marks migration complete');
    } catch (error) {
      this.logger.error('Failed to migrate to session_marks', { error });
    }
  }

  private migrateRecommendationsColumns(): void {
    try {
      const tableInfo = this.db.pragma('table_info(recommendations)') as Array<{ name: string }>;
      const columnNames = tableInfo.map(col => col.name);

      if (!columnNames.includes('project_path')) {
        this.db.exec("ALTER TABLE recommendations ADD COLUMN project_path TEXT DEFAULT NULL");
        this.logger.info('Added project_path column to recommendations');
      }

      if (!columnNames.includes('user_note')) {
        this.db.exec("ALTER TABLE recommendations ADD COLUMN user_note TEXT DEFAULT NULL");
        this.logger.info('Added user_note column to recommendations');
      }

      if (!columnNames.includes('improvement_type')) {
        this.db.exec("ALTER TABLE recommendations ADD COLUMN improvement_type TEXT DEFAULT NULL");
        this.logger.info('Added improvement_type column to recommendations');
      }

      if (!columnNames.includes('source_project')) {
        this.db.exec("ALTER TABLE recommendations ADD COLUMN source_project TEXT DEFAULT NULL");
        this.logger.info('Added source_project column to recommendations');
      }

      if (!columnNames.includes('source_mission')) {
        this.db.exec("ALTER TABLE recommendations ADD COLUMN source_mission TEXT DEFAULT NULL");
        this.logger.info('Added source_mission column to recommendations');
      }
    } catch (error) {
      this.logger.debug('Recommendations migration check failed', { error });
    }
  }

  /**
   * Migration: fold the two queues the inbox replaced into session_inbox, once.
   * `queued_user_messages` held a mid-turn Codex input with a receipt state;
   * `worker_deliveries` held a worker's report or question for its
   * coordinator. Rows that were never handed to a turn come across unread and
   * are drained at the next opportunity; a row that was mid-delivery when the
   * previous server died comes across with an attempt counted, so the drain
   * says it may have been seen. A user row the caller already saw fail or
   * saw marked unknown is not resurrected: it was surfaced for resending.
   */
  private migrateQueuesToInbox(): void {
    const migrationKey = 'session_inbox_unified_v1';
    const state = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(migrationKey) as { value?: string } | undefined;
    if (state?.value === 'true') return;
    const tables = new Set(
      (this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('queued_user_messages', 'worker_deliveries')`)
        .all() as Array<{ name: string }>).map((row) => row.name),
    );
    this.db.transaction(() => {
      if (tables.has('queued_user_messages')) {
        this.db.exec(`
          INSERT OR IGNORE INTO session_inbox
            (id, session_id, source, text, attachments_json, model, reasoning_effort, created_at, attempts, last_error)
          SELECT id, session_id, 'user', display_content, attachments_json, model, reasoning_effort, created_at,
                 CASE status WHEN 'supplying' THEN 1 ELSE 0 END, last_error
          FROM queued_user_messages
          WHERE provider = 'codex' AND status IN ('pending', 'supplying')
        `);
        this.db.exec('DROP TABLE queued_user_messages');
      }
      if (tables.has('worker_deliveries')) {
        this.db.exec(`
          INSERT OR IGNORE INTO session_inbox
            (id, session_id, source, text, worker, created_at, attempts, last_error, read_at)
          SELECT id, coordinator, CASE kind WHEN 'question' THEN 'worker-question' ELSE 'worker-report' END,
                 -- The old rows held the delivery as sent, header and all; the
                 -- inbox holds the worker's own text and writes the header at drain.
                 CASE WHEN instr(input, ']' || char(10) || char(10)) > 0 AND substr(input, 1, 1) = '['
                      THEN substr(input, instr(input, ']' || char(10) || char(10)) + 3) ELSE input END,
                 worker, created_at, CASE status WHEN 'sending' THEN 1 ELSE 0 END, last_error,
                 CASE status WHEN 'sent' THEN COALESCE(sent_at, created_at) ELSE NULL END
          FROM worker_deliveries
        `);
        this.db.exec('DROP TABLE worker_deliveries');
      }
      this.db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(migrationKey, 'true');
    })();
    if (tables.size > 0) this.logger.info('Folded queued_user_messages and worker_deliveries into session_inbox');
  }

  /** Inboxes created before the fast responder: add its two columns. */
  private migrateInboxReplyColumns(): void {
    const columns = (this.db.pragma('table_info(session_inbox)') as Array<{ name: string }>).map((column) => column.name);
    if (!columns.includes('reply')) {
      this.db.exec('ALTER TABLE session_inbox ADD COLUMN reply TEXT');
      this.logger.info('Added reply column to session_inbox');
    }
    if (!columns.includes('reply_pending')) {
      this.db.exec('ALTER TABLE session_inbox ADD COLUMN reply_pending INTEGER NOT NULL DEFAULT 0');
      this.logger.info('Added reply_pending column to session_inbox');
    }
  }

  /**
   * Migration: who an inbox item is from and which event it was made from
   * (see the session_inbox comment). The unique index is created here, after
   * the column, so a database from before it has the column first.
   */
  private migrateInboxProvenanceColumns(): void {
    const columns = (this.db.pragma('table_info(session_inbox)') as Array<{ name: string }>).map((column) => column.name);
    const added: Array<[string, string]> = [
      ['sender', 'TEXT'],
      ['passed_on', 'INTEGER NOT NULL DEFAULT 0'],
      ['source_seq', 'INTEGER'],
      ['delivery_id', 'TEXT'],
    ];
    for (const [name, type] of added) {
      if (columns.includes(name)) continue;
      this.db.exec(`ALTER TABLE session_inbox ADD COLUMN ${name} ${type}`);
      this.logger.info(`Added ${name} column to session_inbox`);
    }
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_session_inbox_delivery
      ON session_inbox(session_id, delivery_id) WHERE delivery_id IS NOT NULL`);
  }

  /** Inboxes created before delivery into a running turn: the reservation, answer and after-turn columns. */
  private migrateInboxReservationColumns(): void {
    const columns = (this.db.pragma('table_info(session_inbox)') as Array<{ name: string }>).map((column) => column.name);
    const added: Array<[string, string]> = [
      ['answers_id', 'TEXT'],
      ['reserved_by', 'TEXT'],
      ['reserved_at', 'TEXT'],
      ['reservation_state', 'TEXT'],
      ['after_turn', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [name, type] of added) {
      if (columns.includes(name)) continue;
      this.db.exec(`ALTER TABLE session_inbox ADD COLUMN ${name} ${type}`);
      this.logger.info(`Added ${name} column to session_inbox`);
    }
  }

  private consolidateConversationInsightsRows(): void {
    const migrationKey = 'session_insights_conversation_consolidated_v1';
    const setMigrationStateStmt = this.db.prepare(
      'INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    );

    try {
      const migrationState = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(migrationKey) as { value?: string } | undefined;
      if (migrationState?.value === 'true') {
        return;
      }

      const mergeStmt = this.db.prepare(`
        INSERT INTO session_insights (
          session_id,
          context,
          tags,
          theme,
          computed_at,
          stale,
          message_count,
          patched_at,
          purpose,
          lines_added,
          lines_removed,
          edit_count,
          write_count,
          metrics_updated_at
        )
        SELECT
          s.conversation_id,
          i.context,
          i.tags,
          i.theme,
          i.computed_at,
          i.stale,
          i.message_count,
          i.patched_at,
          i.purpose,
          i.lines_added,
          i.lines_removed,
          i.edit_count,
          i.write_count,
          i.metrics_updated_at
        FROM session_insights i
        JOIN sessions s ON s.session_id = i.session_id
        WHERE s.conversation_id LIKE 'conv-%'
          AND s.conversation_id IS NOT NULL
        ON CONFLICT(session_id) DO UPDATE SET
          context = COALESCE(session_insights.context, excluded.context),
          tags = COALESCE(session_insights.tags, excluded.tags),
          theme = COALESCE(session_insights.theme, excluded.theme),
          purpose = COALESCE(session_insights.purpose, excluded.purpose),
          computed_at = CASE
            WHEN session_insights.computed_at >= excluded.computed_at THEN session_insights.computed_at
            ELSE excluded.computed_at
          END,
          stale = CASE
            WHEN session_insights.stale = 0 OR excluded.stale = 0 THEN 0
            ELSE 1
          END,
          message_count = CASE
            WHEN session_insights.message_count IS NULL THEN excluded.message_count
            WHEN excluded.message_count IS NULL THEN session_insights.message_count
            WHEN session_insights.message_count >= excluded.message_count THEN session_insights.message_count
            ELSE excluded.message_count
          END,
          patched_at = CASE
            WHEN session_insights.patched_at IS NULL THEN excluded.patched_at
            WHEN excluded.patched_at IS NULL THEN session_insights.patched_at
            WHEN session_insights.patched_at >= excluded.patched_at THEN session_insights.patched_at
            ELSE excluded.patched_at
          END,
          lines_added = CASE
            WHEN session_insights.lines_added >= excluded.lines_added THEN session_insights.lines_added
            ELSE excluded.lines_added
          END,
          lines_removed = CASE
            WHEN session_insights.lines_removed >= excluded.lines_removed THEN session_insights.lines_removed
            ELSE excluded.lines_removed
          END,
          edit_count = CASE
            WHEN session_insights.edit_count >= excluded.edit_count THEN session_insights.edit_count
            ELSE excluded.edit_count
          END,
          write_count = CASE
            WHEN session_insights.write_count >= excluded.write_count THEN session_insights.write_count
            ELSE excluded.write_count
          END,
          metrics_updated_at = CASE
            WHEN session_insights.metrics_updated_at IS NULL THEN excluded.metrics_updated_at
            WHEN excluded.metrics_updated_at IS NULL THEN session_insights.metrics_updated_at
            WHEN session_insights.metrics_updated_at >= excluded.metrics_updated_at THEN session_insights.metrics_updated_at
            ELSE excluded.metrics_updated_at
          END
      `);

      const deleteLegacyRowsStmt = this.db.prepare(`
        DELETE FROM session_insights
        WHERE session_id IN (
          SELECT s.session_id
          FROM sessions s
          WHERE s.conversation_id LIKE 'conv-%'
            AND s.conversation_id IS NOT NULL
        )
          AND session_id NOT LIKE 'conv-%'
      `);

      const transaction = this.db.transaction(() => {
        const merged = mergeStmt.run();
        const deleted = deleteLegacyRowsStmt.run();
        setMigrationStateStmt.run(migrationKey, 'true');
        return {
          mergedChanges: merged.changes,
          deletedLegacyRows: deleted.changes,
        };
      });

      const result = transaction();
      if ((result.mergedChanges || 0) > 0 || (result.deletedLegacyRows || 0) > 0) {
        this.logger.info('Consolidated provider-keyed insights rows into canonical conversations', result);
      }
    } catch (error) {
      this.logger.warn('Failed to consolidate canonical conversation insights rows', { error });
    }
  }
}
