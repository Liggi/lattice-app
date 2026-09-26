import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { createLogger, type Logger } from './infrastructure/logger.js';
import { DatabaseProvider } from './infrastructure/database-provider.js';
import { parseJson } from '../utils/json.js';

/**
 * Question definition from AskUserQuestion tool
 */
export interface QuestionDefinition {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/**
 * A pending question waiting for user response
 */
export interface PendingQuestion {
  id: string;
  sessionId: string;         // Claude session ID (for --resume)
  streamingId: string;       // CUI streaming ID (for correlation)
  toolUseId: string;         // Original tool_use ID
  questions: QuestionDefinition[];
  createdAt: string;
  status: 'pending' | 'answered' | 'expired';
  answers?: Record<string, string>;
  answeredAt?: string;
  resumedStreamingId?: string;  // Streaming ID of the resumed session
}

type PendingQuestionRow = {
  id: string;
  session_id: string;
  streaming_id: string;
  tool_use_id: string;
  questions: string;  // JSON
  created_at: string;
  status: string;
  answers: string | null;  // JSON
  answered_at: string | null;
  resumed_streaming_id: string | null;
};

/**
 * Service to persist AskUserQuestion requests across browser disconnects and server restarts.
 *
 * Flow:
 * 1. Claude calls AskUserQuestion → we detect tool_use and save here
 * 2. TUI times out (~6 sec) → session ends
 * 3. User returns (even after browser close) → we show pending question
 * 4. User answers → we --resume the session with the answer as context
 *
 * Emits `'changed'` with `{ sessionId: string | null }` on every mutation, so
 * the activity stream can push question state to clients instead of them
 * polling for it. `sessionId` is whatever ID the question row carries (conv-*
 * for unified sessions); null means "one or more sessions changed, refetch".
 */
export class PendingQuestionService extends EventEmitter {
  private static instance: PendingQuestionService;
  private logger: Logger;
  private dbPath!: string;
  private configDir!: string;
  private isInitialized = false;
  private db!: Database.Database;

  /** Pending questions older than this are auto-expired on boot and periodic cleanup. */
  private static readonly STALE_QUESTION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
  private static readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  private cleanupInterval: NodeJS.Timeout | null = null;

  // Prepared statements
  private insertStmt!: Database.Statement;
  private getByIdStmt!: Database.Statement;
  private getBySessionStmt!: Database.Statement;
  private getByStreamingIdStmt!: Database.Statement;
  private getPendingStmt!: Database.Statement;
  private getPendingByConversationIdStmt!: Database.Statement;
  private markAnsweredStmt!: Database.Statement;
  private markExpiredStmt!: Database.Statement;
  private expireByStreamingIdStmt!: Database.Statement;
  private expireStaleStmt!: Database.Statement;
  private expireOrphanedLiveCodexStmt!: Database.Statement;
  private setResumedStreamingIdStmt!: Database.Statement;
  private deleteStmt!: Database.Statement;

  constructor(customConfigDir?: string) {
    super();
    // One listener per open activity-stream client; the default cap of 10
    // would warn spuriously with a handful of tabs and devtools reconnects.
    this.setMaxListeners(100);
    this.logger = createLogger('PendingQuestionService');
    this.customConfigDir = customConfigDir;
  }

  private emitChanged(sessionId: string | null): void {
    this.emit('changed', { sessionId });
  }

  private customConfigDir?: string;

  static getInstance(): PendingQuestionService {
    if (!PendingQuestionService.instance) {
      PendingQuestionService.instance = new PendingQuestionService();
    }
    return PendingQuestionService.instance;
  }

  static resetInstance(): void {
    PendingQuestionService.instance = null as unknown as PendingQuestionService;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      const providerArg = this.customConfigDir === ':memory:' ? ':memory:' : this.customConfigDir || undefined;
      const provider = DatabaseProvider.getInstance(providerArg);
      this.db = provider.getDb();
      this.dbPath = provider.getDbPath();
      this.configDir = this.dbPath === ':memory:' ? ':memory:' : '';

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pending_questions (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          streaming_id TEXT NOT NULL,
          tool_use_id TEXT NOT NULL,
          questions TEXT NOT NULL,
          created_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          answers TEXT,
          answered_at TEXT,
          resumed_streaming_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_pending_questions_session ON pending_questions(session_id);
        CREATE INDEX IF NOT EXISTS idx_pending_questions_status ON pending_questions(status);
      `);

      this.prepareStatements();
      this.isInitialized = true;

      // Codex request_user_input rows are backed by a live JSON-RPC responder
      // held in memory. A server restart necessarily kills that responder, so
      // leaving these rows pending would show a question that can only 409.
      const expiredLiveCodex = this.expireOrphanedLiveCodexStmt.run().changes;
      if (expiredLiveCodex > 0) {
        this.logger.info('Expired orphaned live Codex questions on boot', {
          count: expiredLiveCodex,
        });
      }

      // Expire stale questions from previous runs on boot
      const expiredOnBoot = this.expireStaleQuestions();
      if (expiredOnBoot > 0) {
        this.logger.info('Expired stale pending questions on boot', { count: expiredOnBoot });
      }

      // Periodic cleanup
      this.cleanupInterval = setInterval(() => {
        const expired = this.expireStaleQuestions();
        if (expired > 0) {
          this.logger.info('Expired stale pending questions (periodic)', { count: expired });
        }
      }, PendingQuestionService.CLEANUP_INTERVAL_MS);

      this.logger.info('PendingQuestionService initialized');
    } catch (error) {
      this.logger.error('Failed to initialize pending questions database', error);
      throw error;
    }
  }

  private prepareStatements(): void {
    this.insertStmt = this.db.prepare(`
      INSERT INTO pending_questions (
        id, session_id, streaming_id, tool_use_id, questions, created_at, status
      ) VALUES (
        @id, @session_id, @streaming_id, @tool_use_id, @questions, @created_at, @status
      )
    `);

    this.getByIdStmt = this.db.prepare('SELECT * FROM pending_questions WHERE id = ?');
    this.getBySessionStmt = this.db.prepare('SELECT * FROM pending_questions WHERE session_id = ?');
    this.getByStreamingIdStmt = this.db.prepare('SELECT * FROM pending_questions WHERE streaming_id = ? AND status = ?');
    this.getPendingStmt = this.db.prepare("SELECT * FROM pending_questions WHERE status = 'pending' ORDER BY created_at DESC");

    this.markAnsweredStmt = this.db.prepare(`
      UPDATE pending_questions
      SET status = 'answered', answers = @answers, answered_at = @answered_at
      WHERE id = @id
    `);

    this.markExpiredStmt = this.db.prepare("UPDATE pending_questions SET status = 'expired' WHERE id = ?");

    this.setResumedStreamingIdStmt = this.db.prepare(`
      UPDATE pending_questions SET resumed_streaming_id = ? WHERE id = ?
    `);

    this.deleteStmt = this.db.prepare('DELETE FROM pending_questions WHERE id = ?');

    this.getPendingByConversationIdStmt = this.db.prepare(
      "SELECT * FROM pending_questions WHERE session_id = ? AND status = 'pending' ORDER BY created_at DESC"
    );

    this.expireByStreamingIdStmt = this.db.prepare(
      "UPDATE pending_questions SET status = 'expired' WHERE streaming_id = ? AND status = 'pending'"
    );

    this.expireStaleStmt = this.db.prepare(
      "UPDATE pending_questions SET status = 'expired' WHERE status = 'pending' AND created_at < ?"
    );

    this.expireOrphanedLiveCodexStmt = this.db.prepare(
      "UPDATE pending_questions SET status = 'expired' WHERE status = 'pending' AND id LIKE 'codex-question-%'"
    );
  }

  /**
   * Save a new pending question
   */
  addQuestion(
    id: string,
    sessionId: string,
    streamingId: string,
    toolUseId: string,
    questions: QuestionDefinition[]
  ): PendingQuestion {
    const question: PendingQuestion = {
      id,
      sessionId,
      streamingId,
      toolUseId,
      questions,
      createdAt: new Date().toISOString(),
      status: 'pending'
    };

    this.insertStmt.run({
      id: question.id,
      session_id: question.sessionId,
      streaming_id: question.streamingId,
      tool_use_id: question.toolUseId,
      questions: JSON.stringify(question.questions),
      created_at: question.createdAt,
      status: question.status
    });

    this.logger.info('Pending question saved', { id, sessionId, questionCount: questions.length });
    this.emitChanged(sessionId);
    return question;
  }

  /**
   * Get a question by ID
   */
  getQuestion(id: string): PendingQuestion | null {
    const row = this.getByIdStmt.get(id) as PendingQuestionRow | undefined;
    return row ? this.rowToQuestion(row) : null;
  }

  /**
   * Get all questions for a session (any status)
   */
  getQuestionsBySession(sessionId: string): PendingQuestion[] {
    const rows = this.getBySessionStmt.all(sessionId) as PendingQuestionRow[];
    return rows.map(row => this.rowToQuestion(row));
  }

  /**
   * Get pending questions for a streaming ID
   */
  getPendingByStreamingId(streamingId: string): PendingQuestion[] {
    const rows = this.getByStreamingIdStmt.all(streamingId, 'pending') as PendingQuestionRow[];
    return rows.map(row => this.rowToQuestion(row));
  }

  /**
   * Get all pending questions (across all sessions)
   */
  getAllPending(): PendingQuestion[] {
    const rows = this.getPendingStmt.all() as PendingQuestionRow[];
    return rows.map(row => this.rowToQuestion(row));
  }

  /**
   * Mark a question as answered
   */
  markAnswered(id: string, answers: Record<string, string>): boolean {
    const existing = this.getQuestion(id);
    const result = this.markAnsweredStmt.run({
      id,
      answers: JSON.stringify(answers),
      answered_at: new Date().toISOString()
    });

    if (result.changes > 0) {
      this.logger.info('Question marked as answered', { id, answers });
      this.emitChanged(existing?.sessionId ?? null);
      return true;
    }
    return false;
  }

  /**
   * Mark a question as expired (e.g., session was manually closed)
   */
  markExpired(id: string): boolean {
    const existing = this.getQuestion(id);
    const result = this.markExpiredStmt.run(id);
    if (result.changes > 0) {
      this.emitChanged(existing?.sessionId ?? null);
      return true;
    }
    return false;
  }

  /**
   * Set the streaming ID of the resumed session
   */
  setResumedStreamingId(id: string, streamingId: string): boolean {
    const result = this.setResumedStreamingIdStmt.run(streamingId, id);
    return result.changes > 0;
  }

  /**
   * Expire all pending questions for a streaming ID.
   * Called when a process closes without the user having answered.
   */
  expirePendingByStreamingId(streamingId: string): number {
    const result = this.expireByStreamingIdStmt.run(streamingId);
    if (result.changes > 0) {
      this.logger.info('Expired pending questions for streaming session', {
        streamingId,
        expiredCount: result.changes,
      });
      this.emitChanged(null);
    }
    return result.changes;
  }

  /**
   * Expire pending questions older than the TTL.
   * Returns the number of questions expired.
   */
  expireStaleQuestions(): number {
    const cutoff = new Date(Date.now() - PendingQuestionService.STALE_QUESTION_TTL_MS).toISOString();
    const result = this.expireStaleStmt.run(cutoff);
    if (result.changes > 0) {
      this.emitChanged(null);
    }
    return result.changes;
  }

  /**
   * Get pending questions for a specific conversation/session ID.
   */
  getPendingByConversationId(sessionId: string): PendingQuestion[] {
    const rows = this.getPendingByConversationIdStmt.all(sessionId) as PendingQuestionRow[];
    return rows.map(row => this.rowToQuestion(row));
  }

  /**
   * Stop the periodic cleanup interval (for clean shutdown / testing).
   */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Delete a question
   */
  delete(id: string): boolean {
    const existing = this.getQuestion(id);
    const result = this.deleteStmt.run(id);
    if (result.changes > 0) {
      this.emitChanged(existing?.sessionId ?? null);
      return true;
    }
    return false;
  }

  private rowToQuestion(row: PendingQuestionRow): PendingQuestion {
    return {
      id: row.id,
      sessionId: row.session_id,
      streamingId: row.streaming_id,
      toolUseId: row.tool_use_id,
      questions: parseJson(row.questions) as QuestionDefinition[],
      createdAt: row.created_at,
      status: row.status as 'pending' | 'answered' | 'expired',
      answers: row.answers ? parseJson(row.answers) as Record<string, string> : undefined,
      answeredAt: row.answered_at ?? undefined,
      resumedStreamingId: row.resumed_streaming_id ?? undefined
    };
  }
}
