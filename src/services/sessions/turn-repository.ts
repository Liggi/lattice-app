/**
 * TurnRepository - Per-turn summaries and metadata.
 *
 * Extracted from SessionInfoService to separate turn tracking from session management.
 * Each turn represents one assistant response with its headline, actions, and metadata.
 *
 * Tables managed:
 * - session_turns
 */

import Database from 'better-sqlite3';
import { createLogger, type Logger } from '../infrastructure/logger.js';
import { DatabaseProvider } from '../infrastructure/database-provider.js';

export interface TurnRecord {
  id: string;
  session_id: string;
  turn_number: number;
  timestamp: string;
  headline: string;
  actions: string;  // JSON stringified array
  tag: string;
  icon: string;
  exit_code: number | null;
  termination_reason: string;
  tool_count: number;
  incomplete: number;
}

export class TurnRepository {
  private static instance: TurnRepository;
  private logger: Logger;

  constructor(private db: Database.Database) {
    this.logger = createLogger('TurnRepository');
  }

  static getInstance(): TurnRepository {
    if (!TurnRepository.instance) {
      TurnRepository.instance = new TurnRepository(DatabaseProvider.getInstance().getDb());
    }
    return TurnRepository.instance;
  }

  static resetInstance(): void {
    TurnRepository.instance = null as unknown as TurnRepository;
  }

  /**
   * Save a turn to the database.
   */
  async save(turn: TurnRecord): Promise<void> {
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO session_turns (
          id, session_id, turn_number, timestamp, headline, actions,
          tag, icon, exit_code, termination_reason, tool_count, incomplete
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        turn.id,
        turn.session_id,
        turn.turn_number,
        turn.timestamp,
        turn.headline,
        turn.actions,
        turn.tag,
        turn.icon,
        turn.exit_code,
        turn.termination_reason,
        turn.tool_count,
        turn.incomplete
      );
      this.logger.debug('Turn saved', {
        sessionId: turn.session_id.slice(0, 8),
        turnNumber: turn.turn_number,
        terminationReason: turn.termination_reason
      });
    } catch (error) {
      this.logger.error('Failed to save turn', error, { turnId: turn.id });
      throw error;
    }
  }

  /**
   * Get all turns for a session, ordered by turn number.
   * Supports both full session IDs and short prefixes.
   */
  async getForSession(sessionId: string): Promise<TurnRecord[]> {
    try {
      const matchPattern = sessionId.length < 36 ? `${sessionId}%` : sessionId;
      const rows = this.db.prepare(`
        SELECT * FROM session_turns
        WHERE session_id LIKE ?
        ORDER BY turn_number ASC
      `).all(matchPattern) as TurnRecord[];
      return rows;
    } catch (error) {
      this.logger.debug('Failed to get turns', { error, sessionId: sessionId.slice(0, 8) });
      return [];
    }
  }

  /**
   * Get turn count for a session (without fetching all data).
   */
  async getCount(sessionId: string): Promise<number> {
    try {
      const matchPattern = sessionId.length < 36 ? `${sessionId}%` : sessionId;
      const result = this.db.prepare(`
        SELECT COUNT(*) as count FROM session_turns WHERE session_id LIKE ?
      `).get(matchPattern) as { count: number };
      return result.count;
    } catch (error) {
      this.logger.debug('Failed to get turn count', { error });
      return 0;
    }
  }
}
