/**
 * Session Branch Service
 *
 * Creates branch sessions by truncating conversation history to a specific turn.
 * Enables "rewind and branch" functionality - pick a point in history and start fresh.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { createLogger } from '../infrastructure/logger.js';
import { ClaudeHistoryReader } from '../sessions/claude-history-reader.js';
import { SessionInfoService } from '../sessions/session-info-service.js';
import { parseJson } from '../../utils/json.js';

const logger = createLogger('SessionBranchService');

interface RawJsonEntry {
  type: string;
  subtype?: string;
  uuid?: string;
  sessionId?: string;
  parentUuid?: string | null;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  cwd?: string;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  [key: string]: unknown;
}

interface BranchResult {
  newSessionId: string;
  turnCount: number;
  messageCount: number;
}

export class SessionBranchService {
  private static instance: SessionBranchService;
  private claudeHomePath: string;
  private historyReader: ClaudeHistoryReader;
  private sessionInfoService: SessionInfoService;

  private constructor() {
    this.claudeHomePath = path.join(os.homedir(), '.claude');
    this.historyReader = new ClaudeHistoryReader();
    this.sessionInfoService = SessionInfoService.getInstance();
  }

  static getInstance(): SessionBranchService {
    if (!SessionBranchService.instance) {
      SessionBranchService.instance = new SessionBranchService();
    }
    return SessionBranchService.instance;
  }

  /**
   * Create a branch from a session at a specific turn.
   * The branch will contain all content up through the specified turn.
   *
   * @param sessionId - Source session to branch from
   * @param options - Branch options including turn number and optional timestamp
   * @returns New session ID and metadata
   */
  async branchAfterTurn(sessionId: string, afterTurn: number, timestamp?: string): Promise<BranchResult> {
    logger.info('Creating branch', { sessionId: sessionId.slice(0, 8), afterTurn, timestamp });

    // Find the source session file — its directory is used as the target for the branch
    const sourceFile = await this.findSessionFile(sessionId);
    if (!sourceFile) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const targetDir = path.dirname(sourceFile);

    // Read and parse all lines
    const content = await fs.readFile(sourceFile, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    const entries: RawJsonEntry[] = lines.map(line => parseJson(line) as RawJsonEntry);

    // Find turn boundaries (human text messages, not tool results)
    const turnStartIndices = this.findTurnBoundaries(entries);

    // Determine where to cut
    let cutIndex: number;
    let actualTurnNumber: number;

    if (timestamp) {
      // Use timestamp to find the correct cut position
      // This handles the case where DB turn numbers don't match JSONL turn counts
      const result = this.findCutIndexByTimestamp(entries, turnStartIndices, timestamp);
      cutIndex = result.cutIndex;
      actualTurnNumber = result.turnNumber;
      logger.info('Found cut position by timestamp', {
        sessionId: sessionId.slice(0, 8),
        requestedTurn: afterTurn,
        actualTurn: actualTurnNumber,
        cutIndex,
        totalEntries: entries.length,
      });
    } else {
      // Fall back to turn number (legacy behavior)
      if (afterTurn < 1 || afterTurn > turnStartIndices.length) {
        throw new Error(`Invalid turn number ${afterTurn}. Session has ${turnStartIndices.length} turns.`);
      }

      if (afterTurn === turnStartIndices.length) {
        // Branching after the last turn - include everything
        cutIndex = entries.length;
      } else {
        // Cut before the next turn starts
        cutIndex = turnStartIndices[afterTurn]; // afterTurn is 1-indexed, array is 0-indexed
      }
      actualTurnNumber = afterTurn;
    }

    // Safety net: if the cut lands right after a compact_boundary, extend it to
    // include the compaction summary. These two entries are an atomic pair — the
    // boundary says "context was compacted" and the summary IS the compacted context.
    // Splitting them leaves Claude with zero history.
    cutIndex = this.ensureCompactBoundaryIntegrity(entries, cutIndex);

    // Generate new session ID
    const newSessionId = randomUUID();

    // Create new entries with updated sessionId
    const branchEntries = entries.slice(0, cutIndex).map(entry => ({
      ...entry,
      sessionId: entry.sessionId ? newSessionId : entry.sessionId,
    }));

    // Write the new session file (same directory as source — already resolved by findSessionFile)
    const newFilePath = path.join(targetDir, `${newSessionId}.jsonl`);
    const newContent = branchEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
    await fs.writeFile(newFilePath, newContent, { mode: 0o600 });

    // Ensure session record exists before copying related data (foreign key constraint)
    // Store branch lineage so we can show "branched from" in the UI
    logger.info('Saving branch lineage to DB', {
      newSessionId: newSessionId.slice(0, 8),
      parentSessionId: sessionId.slice(0, 8),
      atTurn: afterTurn,
    });
    const savedSessionInfo = await this.sessionInfoService.updateSessionInfo(newSessionId, {
      archived: false,
      branched_from_session_id: sessionId,
      branched_at_turn: afterTurn,
    });
    logger.info('Saved session info', {
      newSessionId: newSessionId.slice(0, 8),
      savedBranchedFrom: savedSessionInfo.branched_from_session_id?.slice(0, 8),
      savedAtTurn: savedSessionInfo.branched_at_turn,
    });

    // Copy relevant database records (turns) for the included turns
    const copiedTurns = this.copySessionData(sessionId, newSessionId, afterTurn);

    logger.info('Branch created', {
      sourceSession: sessionId.slice(0, 8),
      newSession: newSessionId.slice(0, 8),
      dbTurn: afterTurn,
      jsonlTurn: actualTurnNumber,
      messages: branchEntries.length,
      targetDir: path.basename(targetDir),
      copiedTurns,
    });

    return {
      newSessionId,
      turnCount: afterTurn, // Return DB turn number for consistency with UI
      messageCount: branchEntries.length,
    };
  }

  /**
   * Copy session turns from source to branch.
   * Only copies data for turns <= afterTurn.
   */
  private copySessionData(
    sourceSessionId: string,
    newSessionId: string,
    afterTurn: number
  ): number {
    try {
      const turnsCopied = this.sessionInfoService.copyTurnsForBranch(
        sourceSessionId,
        newSessionId,
        afterTurn
      );

      logger.debug('Copied session data for branch', {
        sourceSession: sourceSessionId.slice(0, 8),
        newSession: newSessionId.slice(0, 8),
        afterTurn,
        turnsCopied,
      });

      return turnsCopied;
    } catch (error) {
      logger.warn('Failed to copy session data for branch', {
        sourceSession: sourceSessionId.slice(0, 8),
        newSession: newSessionId.slice(0, 8),
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Find indices where each turn starts (human text messages).
   * A "turn" begins with a user message containing actual text content,
   * not tool results.
   */
  private findTurnBoundaries(entries: RawJsonEntry[]): number[] {
    const boundaries: number[] = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.type === 'user' && this.hasHumanText(entry)) {
        boundaries.push(i);
      }
    }

    return boundaries;
  }

  /**
   * Check if a user message contains actual human text (not just tool results).
   * Excludes compaction summaries — these are system-generated context, not human turns.
   */
  private hasHumanText(entry: RawJsonEntry): boolean {
    // Compaction summaries look like user messages with text content, but they're
    // system-generated. They must stay paired with their compact_boundary marker
    // and never be treated as turn boundaries (otherwise a branch cut can land
    // between the boundary and its summary, losing all compacted context).
    if (entry.isCompactSummary) {
      return false;
    }

    const content = entry.message?.content;

    // String content is human text
    if (typeof content === 'string' && content.trim()) {
      return true;
    }

    // Array content - check for text blocks (not tool_result)
    if (Array.isArray(content)) {
      return content.some(
        block => {
          const typedBlock = block as { type?: string } | null;
          return typedBlock?.type === 'text' && 'text' in (typedBlock as object);
        }
      );
    }

    return false;
  }

  /**
   * Find the cut index by matching a timestamp to a turn in the JSONL.
   * This handles the discrepancy between DB turn numbers and JSONL turn counts.
   *
   * Strategy: Find the turn whose user message timestamp is closest to the target,
   * then return the cut index (start of the next turn, or end of file).
   */
  private findCutIndexByTimestamp(
    entries: RawJsonEntry[],
    turnStartIndices: number[],
    targetTimestamp: string
  ): { cutIndex: number; turnNumber: number } {
    const targetMs = new Date(targetTimestamp).getTime();

    // Find the turn with the closest timestamp
    let bestTurnIndex = -1;
    let bestDiff = Infinity;

    for (let i = 0; i < turnStartIndices.length; i++) {
      const entryIndex = turnStartIndices[i];
      const entry = entries[entryIndex];

      if (entry.timestamp) {
        const entryMs = new Date(entry.timestamp).getTime();
        const diff = Math.abs(entryMs - targetMs);

        // Prefer turns that are at or before the target timestamp
        // If timestamp matches within 1 second, consider it a match
        if (diff < bestDiff) {
          bestDiff = diff;
          bestTurnIndex = i;
        }
      }
    }

    // If no match found, fall back to last turn
    if (bestTurnIndex === -1) {
      logger.warn('No timestamp match found, using last turn', { targetTimestamp });
      bestTurnIndex = turnStartIndices.length - 1;
    }

    const turnNumber = bestTurnIndex + 1; // 1-indexed

    // Determine cut index: include this turn and everything before it
    let cutIndex: number;
    if (bestTurnIndex === turnStartIndices.length - 1) {
      // Last turn - include everything
      cutIndex = entries.length;
    } else {
      // Cut before the next turn starts
      cutIndex = turnStartIndices[bestTurnIndex + 1];
    }

    logger.debug('Timestamp match result', {
      targetTimestamp,
      matchedTurnIndex: bestTurnIndex,
      matchedEntryIndex: turnStartIndices[bestTurnIndex],
      timeDiffMs: bestDiff,
      cutIndex,
    });

    return { cutIndex, turnNumber };
  }

  /**
   * Ensure a cut doesn't split a compact_boundary from its compaction summary.
   * If the last entry before the cut is a compact_boundary (or the cut falls between
   * the boundary and its summary), extend the cut to include the summary.
   */
  private ensureCompactBoundaryIntegrity(entries: RawJsonEntry[], cutIndex: number): number {
    if (cutIndex <= 0 || cutIndex >= entries.length) {
      return cutIndex;
    }

    // Check if any entry in the tail of the included range is a compact_boundary
    // without a following summary. We only need to look at the last few entries.
    const lookbackStart = Math.max(0, cutIndex - 5);
    for (let i = cutIndex - 1; i >= lookbackStart; i--) {
      const entry = entries[i];
      if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
        // Found a boundary — check if its summary is already included
        const summaryIncluded = entries.slice(i + 1, cutIndex).some(e => e.isCompactSummary);
        if (summaryIncluded) {
          return cutIndex; // Already intact
        }

        // Summary is missing — scan forward to find and include it
        for (let j = cutIndex; j < entries.length; j++) {
          if (entries[j].isCompactSummary) {
            const newCutIndex = j + 1;
            logger.info('Extended cut to preserve compact_boundary + summary pair', {
              originalCut: cutIndex,
              newCut: newCutIndex,
              boundaryIndex: i,
              summaryIndex: j,
            });
            return newCutIndex;
          }
          // If we hit a real user message, stop searching
          if (entries[j].type === 'user' && !entries[j].isCompactSummary && !entries[j].isVisibleInTranscriptOnly) {
            break;
          }
        }

        // No summary found (shouldn't happen in valid JSONL) — log warning
        logger.warn('compact_boundary found without following summary', {
          boundaryIndex: i,
          cutIndex,
        });
        break;
      }
    }

    return cutIndex;
  }

  /**
   * Find the JSONL file for a session by checking each project folder.
   */
  private async findSessionFile(sessionId: string): Promise<string | null> {
    const projectsPath = path.join(this.claudeHomePath, 'projects');

    try {
      const projects = await fs.readdir(projectsPath);

      for (const project of projects) {
        const projectPath = path.join(projectsPath, project);
        const stats = await fs.stat(projectPath);
        if (!stats.isDirectory()) continue;

        const sessionFile = path.join(projectPath, `${sessionId}.jsonl`);
        try {
          await fs.access(sessionFile);
          return sessionFile;
        } catch {
          // File doesn't exist in this project, continue
        }
      }

      return null;
    } catch (error) {
      logger.error('Error searching for session file', error, { sessionId });
      return null;
    }
  }

  /**
   * Get the number of turns in a session.
   * Useful for UI to know valid range for branching.
   */
  async getTurnCount(sessionId: string): Promise<number> {
    const sourceFile = await this.findSessionFile(sessionId);
    if (!sourceFile) {
      return 0;
    }

    const content = await fs.readFile(sourceFile, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    const entries: RawJsonEntry[] = lines.map(line => parseJson(line) as RawJsonEntry);

    return this.findTurnBoundaries(entries).length;
  }

  /**
   * Find the UUID of the last message in a specific turn.
   * Used to identify the branch point for UI indicators.
   *
   * @param sessionId - The session to search
   * @param turnNumber - The turn number (1-indexed)
   * @returns The UUID of the last message in that turn, or null if not found
   */
  async getBranchPointMessageId(sessionId: string, turnNumber: number): Promise<string | null> {
    const sourceFile = await this.findSessionFile(sessionId);
    if (!sourceFile) {
      logger.warn('Session file not found for branch point lookup', { sessionId: sessionId.slice(0, 8), turnNumber });
      return null;
    }

    const content = await fs.readFile(sourceFile, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    const entries: RawJsonEntry[] = lines.map(line => parseJson(line) as RawJsonEntry);

    const turnBoundaries = this.findTurnBoundaries(entries);

    if (turnNumber < 1 || turnNumber > turnBoundaries.length) {
      logger.warn('Turn number out of range', { sessionId: sessionId.slice(0, 8), turnNumber, totalTurns: turnBoundaries.length });
      return null;
    }

    // Find the end of the target turn
    let endIndex: number;
    if (turnNumber === turnBoundaries.length) {
      // Last turn - end is at the last entry
      endIndex = entries.length - 1;
    } else {
      // End is just before the next turn starts
      endIndex = turnBoundaries[turnNumber] - 1;
    }

    // Walk backwards from endIndex to find the last displayable message (user or assistant with uuid)
    for (let i = endIndex; i >= 0; i--) {
      const entry = entries[i];
      if ((entry.type === 'user' || entry.type === 'assistant') && entry.uuid) {
        logger.debug('Found branch point message', {
          sessionId: sessionId.slice(0, 8),
          turnNumber,
          messageIndex: i,
          uuid: entry.uuid.slice(0, 8),
        });
        return entry.uuid;
      }
    }

    logger.warn('No displayable message found for turn', { sessionId: sessionId.slice(0, 8), turnNumber });
    return null;
  }
}
