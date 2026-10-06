/**
 * Turn Capture Service
 *
 * Captures structured turn summaries after each Claude process completes.
 * A "turn" is one user message + Claude's complete response.
 *
 * Triggered by process-closed events, extracts the last exchange from JSONL,
 * and uses Haiku to generate a structured summary for:
 * 1. Contextualisation - understanding where you are in the work
 * 2. Post-session learning - feeding to Opus for recommendations
 */

import { createLogger } from '../infrastructure/logger.js';
import { backgroundTextClient, backgroundProvenance, type BackgroundTextClient } from '../infrastructure/background-text-client.js';
import { ClaudeHistoryReader } from '../sessions/claude-history-reader.js';
import { SessionInfoService } from '../sessions/session-info-service.js';
import { TurnRepository } from '../sessions/turn-repository.js';
import { readMessages } from '../../harness/event-message-reader.js';
import { ConversationMessage } from '@/types/index.js';
import type { UnifiedMessage } from '@/types/unified-messages.js';
import { getCostTracker } from '../infrastructure/cost-tracker.js';
import { type TerminationReason } from '@/types/index.js';
import { parseJson } from '../../utils/json.js';
import { allowGeneration } from '../infrastructure/generation-gates.js';

const logger = createLogger('TurnCaptureService');

function mapExitCodeToTerminationReason(exitCode: number | null): TerminationReason {
  if (exitCode === 0 || exitCode === null) return 'normal_completion';
  if (exitCode === 143) return 'user_stop';
  if (exitCode === 137) return 'force_killed';
  return 'process_crash';
}

// =============================================================================
// Types
// =============================================================================

export type { TerminationReason };

export interface Turn {
  id: string;
  sessionId: string;
  turnNumber: number;
  timestamp: string;

  // The exchange - summarized by Haiku
  headline: string;      // User intent, very short (what they wanted)
  actions: string[];     // Single-line outcome summary (what was achieved)

  // Classification
  tag: string;           // decision, fix, pivot, discovery, friction, etc.
  icon: string;          // Emoji for display

  // Metadata
  exitCode: number | null;
  terminationReason: TerminationReason;  // Why the turn ended
  toolCount: number;
  incomplete: boolean;   // Did Claude finish or get cut off?
}

interface TurnRow {
  id: string;
  session_id: string;
  turn_number: number;
  timestamp: string;
  headline: string;
  actions: string;       // JSON array
  tag: string;
  icon: string;
  exit_code: number | null;
  termination_reason: string;
  tool_count: number;
  incomplete: number;
}

interface TurnSummaryResponse {
  headline?: string;
  actions?: unknown;
  tag?: string;
  icon?: string;
}

// =============================================================================
// Service
// =============================================================================

export class TurnCaptureService {
  private static instance: TurnCaptureService;
  private historyReader: ClaudeHistoryReader;
  private sessionInfoService: SessionInfoService;
  /** Track in-flight turn captures so consumers (e.g. review) can wait for them. */
  private pendingCaptures = new Map<string, Promise<Turn | null>>();

  private constructor() {
    this.historyReader = new ClaudeHistoryReader();
    this.sessionInfoService = SessionInfoService.getInstance();
  }

  static getInstance(): TurnCaptureService {
    if (!TurnCaptureService.instance) {
      TurnCaptureService.instance = new TurnCaptureService();
    }
    return TurnCaptureService.instance;
  }

  private getClient(): BackgroundTextClient {
    const client = backgroundTextClient.getClient('turnCapture');
    if (!client) {
      throw new Error(
        'Anthropic client unavailable. Configure an Anthropic API key or active hosted proxy credentials.'
      );
    }
    return client;
  }

  /**
   * Derive termination reason from exit code.
   */
  private deriveTerminationReason(exitCode: number | null): TerminationReason {
    return mapExitCodeToTerminationReason(exitCode);
  }

  /**
   * Capture a turn after Claude process completes.
   * Called from process-closed event handler.
   */
  async captureTurn(
    sessionId: string,
    exitCode: number | null,
    terminationReason?: TerminationReason
  ): Promise<Turn | null> {
    // Feature switch. Fires per turn, so it scales with usage.
    if (!allowGeneration('turnCapture')) return null;

    const promise = this.doCaptureTurn(sessionId, exitCode, terminationReason);
    this.pendingCaptures.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      this.pendingCaptures.delete(sessionId);
    }
  }

  /**
   * Wait for any in-flight turn captures for the given session IDs.
   * Returns once all pending captures have settled (resolved or rejected).
   * Used by the review service to avoid racing with turn capture.
   */
  async waitForPendingCaptures(sessionIds: string[], timeoutMs = 15000): Promise<void> {
    const pending = sessionIds
      .map(id => this.pendingCaptures.get(id))
      .filter((p): p is Promise<Turn | null> => p !== undefined);

    if (pending.length === 0) return;

    logger.info('Waiting for pending turn captures before review', {
      count: pending.length,
      sessionIds: sessionIds.map(id => id.slice(0, 8)),
    });

    await Promise.race([
      Promise.allSettled(pending),
      new Promise(resolve => setTimeout(resolve, timeoutMs)),
    ]);
  }

  private async doCaptureTurn(
    sessionId: string,
    exitCode: number | null,
    terminationReason?: TerminationReason
  ): Promise<Turn | null> {
    const startTime = Date.now();
    const reason = terminationReason ?? this.deriveTerminationReason(exitCode);
    logger.info('Capturing turn', { sessionId: sessionId.slice(0, 8), exitCode, terminationReason: reason });

    try {
      // Try unified message store first
      const unifiedMessages = readMessages(sessionId);
      let lastTurn: ReturnType<typeof this.extractLastTurn>;

      if (unifiedMessages.length > 0) {
        logger.debug('[TURN-DIAG] Using unified message store', {
          sessionId: sessionId.slice(0, 8),
          messageCount: unifiedMessages.length,
        });
        lastTurn = this.extractLastTurnFromUnified(unifiedMessages);
      } else {
        // Fall back to JSONL for pre-unified sessions
        logger.debug('[TURN-DIAG] Unified store empty, falling back to JSONL', {
          sessionId: sessionId.slice(0, 8),
        });
        const { messages } = await this.historyReader.fetchConversationDirect(sessionId);

        if (messages.length === 0) {
          logger.debug('[TURN-DIAG] No messages from JSONL either, skipping', { sessionId: sessionId.slice(0, 8) });
          return null;
        }

        logger.debug('[TURN-DIAG] Got messages from JSONL', { sessionId: sessionId.slice(0, 8), count: messages.length });
        lastTurn = this.extractLastTurn(messages);
      }

      if (!lastTurn) {
        logger.debug('[TURN-DIAG] Could not extract last turn from messages', { sessionId: sessionId.slice(0, 8) });
        return null;
      }

      logger.debug('[TURN-DIAG] Extracted turn, sending to Haiku', {
        sessionId: sessionId.slice(0, 8),
        userMsgLen: lastTurn.userMessage.length,
        claudeRespLen: lastTurn.claudeResponse.length,
        toolCount: lastTurn.toolUses.length,
      });

      // Get existing turns for context
      const existingTurns = await this.getTurnsForSession(sessionId);
      const turnNumber = existingTurns.length + 1;

      // Generate structured summary with Haiku (include previous turns for context)
      const summary = await this.summarizeTurn(
        lastTurn.userMessage,
        lastTurn.claudeResponse,
        lastTurn.toolUses,
        existingTurns.slice(-5), // Last 5 turns for context
        sessionId
      );

      const turn: Turn = {
        id: `turn-${sessionId.slice(0, 8)}-${turnNumber}-${Date.now()}`,
        sessionId,
        turnNumber,
        timestamp: new Date().toISOString(),
        headline: summary.headline,
        actions: summary.actions,
        tag: summary.tag,
        icon: summary.icon,
        exitCode,
        terminationReason: reason,
        toolCount: lastTurn.toolUses.length,
        incomplete: reason !== 'normal_completion',
      };

      // Persist to database
      await this.saveTurn(turn);

      // Save file changes for walkthrough generation
      if (lastTurn.fileChanges.length > 0) {
        const timestamp = turn.timestamp;
        for (const change of lastTurn.fileChanges) {
          try {
            this.sessionInfoService.insertFileChange({
              sessionId,
              turnNumber,
              toolName: change.toolName,
              filePath: change.filePath,
              oldString: change.oldString,
              newString: change.newString,
              timestamp,
            });
          } catch (err) {
            logger.warn('Failed to save file change', { sessionId: sessionId.slice(0, 8), filePath: change.filePath, error: err });
          }
        }
        logger.debug('Saved file changes', { sessionId: sessionId.slice(0, 8), turnNumber, count: lastTurn.fileChanges.length });
      }

      const elapsed = Date.now() - startTime;
      logger.info('Turn captured', {
        sessionId: sessionId.slice(0, 8),
        turnNumber,
        tag: turn.tag,
        terminationReason: reason,
        fileChangeCount: lastTurn.fileChanges.length,
        elapsedMs: elapsed,
      });

      return turn;
    } catch (error) {
      logger.error('Failed to capture turn', error, { sessionId: sessionId.slice(0, 8) });
      return null;
    }
  }

  /**
   * Check if a message contains actual human text (not just tool results).
   */
  private hasHumanText(msg: ConversationMessage): boolean {
    const content = msg.message?.content;
    if (typeof content === 'string' && content.trim()) {
      return true;
    }
    if (Array.isArray(content)) {
      return content.some(
        block => typeof block === 'object' && block !== null && block.type === 'text' && 'text' in block
      );
    }
    return false;
  }

  /**
   * Extract a compact summary of a tool result for turn capture.
   * Focuses on outcomes (success/failure, key data) not full content.
   */
  private summarizeToolResult(toolName: string, result: unknown): string {
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

    // For Edit/Write - just report success/failure and file path
    if (toolName === 'Edit' || toolName === 'Write') {
      if (resultStr.includes('has been updated') || resultStr.includes('successfully')) {
        return '✓ success';
      }
      if (resultStr.includes('error') || resultStr.includes('failed')) {
        return '✗ ' + this.truncate(resultStr, 80);
      }
      return '✓ done';
    }

    // For Bash - capture exit status and key output
    if (toolName === 'Bash') {
      if (resultStr.includes('error') || resultStr.includes('Error') || resultStr.includes('failed')) {
        return '✗ ' + this.truncate(resultStr, 100);
      }
      // Check for common success patterns
      if (resultStr.includes('built in') || resultStr.includes('success') || resultStr.length < 50) {
        return '✓ ' + this.truncate(resultStr, 80);
      }
      return this.truncate(resultStr, 80);
    }

    // For Grep/Glob - report match counts
    if (toolName === 'Grep' || toolName === 'Glob') {
      const matchCount = (resultStr.match(/\n/g) || []).length;
      if (matchCount > 0) {
        return `found ${matchCount} matches`;
      }
      if (resultStr.includes('No matches') || resultStr.includes('No files')) {
        return 'no matches';
      }
      return this.truncate(resultStr, 60);
    }

    // For Read - just confirm it worked
    if (toolName === 'Read') {
      if (resultStr.length > 100) {
        return `✓ read ${Math.round(resultStr.length / 1000)}k chars`;
      }
      return '✓ read';
    }

    // Default: truncate
    return this.truncate(resultStr, 80);
  }

  /**
   * Extract the last HUMAN user message + Claude response from messages.
   * In Claude Code, most "user" messages are tool_results, not human input.
   * We need to find the last user message that contains actual text content.
   * Also captures file changes from Edit/Write tool calls for walkthrough generation.
   */
  private extractLastTurn(messages: ConversationMessage[]): {
    userMessage: string;
    claudeResponse: string;
    toolUses: string[];
    fileChanges: Array<{
      toolName: 'Edit' | 'Write';
      filePath: string;
      oldString: string | null;
      newString: string;
    }>;
  } | null {
    // Find the last user message that has actual human text (not just tool_result)
    let lastHumanIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'user' && this.hasHumanText(messages[i])) {
        lastHumanIdx = i;
        break;
      }
    }

    if (lastHumanIdx === -1) {
      logger.debug('No human message found in conversation');
      return null;
    }

    // Extract user message content from the nested message object
    const userMsg = messages[lastHumanIdx];
    let userMessage = '';
    const userContent = userMsg.message?.content;
    if (typeof userContent === 'string') {
      userMessage = userContent;
    } else if (Array.isArray(userContent)) {
      userMessage = userContent
        .filter((block): block is { type: 'text'; text: string } =>
          typeof block === 'object' && block !== null && block.type === 'text')
        .map(block => block.text)
        .join('\n');
    }

    // Collect Claude's response (everything after the human message)
    // Track tool_use blocks and their results for richer context
    const claudeMessages = messages.slice(lastHumanIdx + 1);
    const toolUses: string[] = [];
    const pendingTools: Map<string, { name: string; input: string; fullInput?: Record<string, unknown> }> = new Map();
    const fileChanges: Array<{
      toolName: 'Edit' | 'Write';
      filePath: string;
      oldString: string | null;
      newString: string;
    }> = [];
    let claudeResponse = '';

    for (const msg of claudeMessages) {
      const content = msg.message?.content;
      if (!Array.isArray(content)) {
        if (msg.type === 'assistant' && typeof content === 'string') {
          claudeResponse += content + '\n';
        }
        continue;
      }

      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;

        if (msg.type === 'assistant') {
          if (block.type === 'text' && 'text' in block) {
            claudeResponse += (block as { type: 'text'; text: string }).text + '\n';
          } else if (block.type === 'tool_use' && 'name' in block && 'id' in block) {
            const toolBlock = block as { type: 'tool_use'; id: string; name: string; input: unknown };
            // Extract key info from input based on tool type
            let inputSummary = '';
            const input = toolBlock.input as Record<string, unknown>;
            if (toolBlock.name === 'Edit' || toolBlock.name === 'Write' || toolBlock.name === 'Read') {
              inputSummary = (input.file_path as string) || '';
            } else if (toolBlock.name === 'Bash') {
              inputSummary = this.truncate((input.command as string) || '', 60);
            } else if (toolBlock.name === 'Grep') {
              inputSummary = `"${String(input.pattern ?? '')}"`;
            } else {
              inputSummary = this.truncate(JSON.stringify(input), 60);
            }
            // Store full input for Edit/Write to capture file changes
            const fullInput = (toolBlock.name === 'Edit' || toolBlock.name === 'Write') ? input : undefined;
            pendingTools.set(toolBlock.id, { name: toolBlock.name, input: inputSummary, fullInput });
          }
        } else if (msg.type === 'user' && block.type === 'tool_result' && 'tool_use_id' in block) {
          // Match tool result to its tool_use
          const resultBlock = block as { type: 'tool_result'; tool_use_id: string; content?: unknown };
          const tool = pendingTools.get(resultBlock.tool_use_id);
          if (tool) {
            const resultSummary = this.summarizeToolResult(tool.name, resultBlock.content);
            toolUses.push(`${tool.name}(${tool.input}) → ${resultSummary}`);

            // Capture file changes for Edit/Write (only on success)
            if ((tool.name === 'Edit' || tool.name === 'Write') && tool.fullInput && resultSummary.startsWith('✓')) {
              const filePath = tool.fullInput.file_path as string;
              const oldString = tool.name === 'Edit' ? (tool.fullInput.old_string as string | null) : null;
              const newString = (tool.fullInput.new_string ?? tool.fullInput.content) as string;
              if (filePath && newString) {
                fileChanges.push({
                  toolName: tool.name as 'Edit' | 'Write',
                  filePath,
                  oldString,
                  newString,
                });
              }
            }

            pendingTools.delete(resultBlock.tool_use_id);
          }
        }
      }
    }

    // Add any tools that didn't get results (interrupted?)
    for (const [_id, tool] of pendingTools) {
      toolUses.push(`${tool.name}(${tool.input}) → (no result)`);
    }

    logger.info('Extracted turn', {
      userMessagePreview: userMessage.slice(0, 50),
      claudeResponseLen: claudeResponse.length,
      toolUseCount: toolUses.length,
      fileChangeCount: fileChanges.length,
    });

    return {
      userMessage: this.truncate(userMessage, 2000),
      claudeResponse: this.truncate(claudeResponse.trim(), 2000),
      toolUses,
      fileChanges,
    };
  }

  /**
   * Extract the last turn from unified messages.
   * Works with both Claude and Codex messages in the unified format.
   */
  private extractLastTurnFromUnified(messages: UnifiedMessage[]): {
    userMessage: string;
    claudeResponse: string;
    toolUses: string[];
    fileChanges: Array<{
      toolName: 'Edit' | 'Write';
      filePath: string;
      oldString: string | null;
      newString: string;
    }>;
  } | null {
    // Find the last user message that has actual human text (not just tool_result)
    let lastHumanIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && this.hasHumanTextUnified(messages[i])) {
        lastHumanIdx = i;
        break;
      }
    }

    if (lastHumanIdx === -1) {
      logger.debug('No human message found in unified messages');
      return null;
    }

    // Extract user message text
    const userMsg = messages[lastHumanIdx];
    let userMessage = '';
    for (const block of userMsg.content) {
      if (block.type === 'text') {
        userMessage += block.text + '\n';
      }
    }

    // Collect Claude's response (everything after the human message)
    const responseMessages = messages.slice(lastHumanIdx + 1);
    const toolUses: string[] = [];
    const pendingTools: Map<string, { name: string; input: string; fullInput?: Record<string, unknown> }> = new Map();
    const fileChanges: Array<{
      toolName: 'Edit' | 'Write';
      filePath: string;
      oldString: string | null;
      newString: string;
    }> = [];
    let claudeResponse = '';

    for (const msg of responseMessages) {
      for (const block of msg.content) {
        if (msg.role === 'assistant') {
          if (block.type === 'text') {
            claudeResponse += block.text + '\n';
          } else if (block.type === 'tool_use') {
            // Extract key info from input based on tool type
            let inputSummary = '';
            const input = block.input;
            if (block.name === 'Edit' || block.name === 'Write' || block.name === 'Read') {
              inputSummary = (input.file_path as string) || '';
            } else if (block.name === 'Bash') {
              inputSummary = this.truncate((input.command as string) || '', 60);
            } else if (block.name === 'Grep') {
              inputSummary = `"${String(input.pattern ?? '')}"`;
            } else {
              inputSummary = this.truncate(JSON.stringify(input), 60);
            }
            // Store full input for Edit/Write to capture file changes
            const fullInput = (block.name === 'Edit' || block.name === 'Write') ? input : undefined;
            pendingTools.set(block.id, { name: block.name, input: inputSummary, fullInput });
          }
        } else if (msg.role === 'user' && block.type === 'tool_result') {
          // Match tool result to its tool_use
          const tool = pendingTools.get(block.toolUseId);
          if (tool) {
            const resultSummary = this.summarizeToolResultUnified(tool.name, block.output, block.isError);
            toolUses.push(`${tool.name}(${tool.input}) → ${resultSummary}`);

            // Capture file changes for Edit/Write (only on success)
            if ((tool.name === 'Edit' || tool.name === 'Write') && tool.fullInput && resultSummary.startsWith('✓')) {
              const filePath = tool.fullInput.file_path as string;
              const oldString = tool.name === 'Edit' ? (tool.fullInput.old_string as string | undefined) ?? null : null;
              const newString = (tool.fullInput.new_string ?? tool.fullInput.content) as string;
              if (filePath && newString) {
                fileChanges.push({
                  toolName: tool.name as 'Edit' | 'Write',
                  filePath,
                  oldString,
                  newString,
                });
              }
            }

            pendingTools.delete(block.toolUseId);
          }
        }
      }
    }

    // Add any tools that didn't get results (interrupted?)
    for (const [_id, tool] of pendingTools) {
      toolUses.push(`${tool.name}(${tool.input}) → (no result)`);
    }

    logger.info('Extracted turn from unified messages', {
      userMessagePreview: userMessage.slice(0, 50),
      claudeResponseLen: claudeResponse.length,
      toolUseCount: toolUses.length,
      fileChangeCount: fileChanges.length,
    });

    return {
      userMessage: this.truncate(userMessage.trim(), 2000),
      claudeResponse: this.truncate(claudeResponse.trim(), 2000),
      toolUses,
      fileChanges,
    };
  }

  /**
   * Check if a unified message has human text (not just tool results).
   */
  private hasHumanTextUnified(message: UnifiedMessage): boolean {
    if (message.role !== 'user') return false;
    return message.content.some(block => block.type === 'text' && block.text.trim().length > 0);
  }

  /**
   * Summarize a tool result from unified format.
   */
  private summarizeToolResultUnified(toolName: string, output: string, isError?: boolean): string {
    if (isError) {
      return `✗ ${this.truncate(output, 50)}`;
    }
    if (output.startsWith('✓') || output.includes('success')) {
      return '✓';
    }
    return this.truncate(output, 50);
  }

  /**
   * Use Haiku to generate a structured turn summary.
   */
  private async summarizeTurn(
    userMessage: string,
    claudeResponse: string,
    toolUses: string[],
    previousTurns: Turn[] = [],
    sessionId?: string
  ): Promise<{
    headline: string;
    actions: string[];
    tag: string;
    icon: string;
  }> {
    const client = this.getClient();

    // Log what we're sending to Haiku
    logger.debug('Summarizing turn', {
      userMessageLen: userMessage.length,
      claudeResponseLen: claudeResponse.length,
      toolUseCount: toolUses.length,
      previousTurnCount: previousTurns.length,
      userMessagePreview: userMessage.slice(0, 100),
    });

    const toolUsesStr = toolUses.length > 0
      ? `\nTool uses (${toolUses.length} total):\n${toolUses.slice(0, 10).map(t => `- ${t}`).join('\n')}`
      : '\n(No tool uses)';

    // Build context from previous turns
    const contextStr = previousTurns.length > 0
      ? `\nPREVIOUS TURNS (for context):\n${previousTurns.map(t =>
          `- ${t.icon} [${t.tag}] ${t.headline}`
        ).join('\n')}\n`
      : '';

    const prompt = `You are summarizing a coding session exchange. Output ONLY valid JSON, no other text.
${contextStr}
CURRENT USER MESSAGE:
${userMessage || '(empty message)'}

CLAUDE'S RESPONSE:
${claudeResponse || '(no response captured)'}${toolUsesStr}

OUTPUT FORMAT - Return ONLY this JSON structure:
{"headline": "5-10 word summary of user intent", "actions": ["single sentence describing what was achieved in this turn"], "tag": "discuss", "icon": "💬"}

ACTIONS RULES:
- actions MUST contain exactly one item
- describe concrete outcome delivered this turn (result/decision/fix), not process steps
- if unfinished/interrupted, state partial outcome clearly

VALID TAGS (text only, no emoji): decision | fix | pivot | discovery | friction | explore | implement | refactor | debug | discuss
ICONS: ⚖️ 🔧 🔄 💡 🚧 🔍 🏗️ ♻️ 🐛 💬

JSON ONLY:`;

    const turnStartTime = Date.now();
    try {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      });

      const turnDurationMs = Date.now() - turnStartTime;

      // Log cost for TURN_CAPTURE operation
      try {
        const costTracker = getCostTracker();
        costTracker.log({
          sessionId: sessionId || 'unknown',
          operation: 'TURN_CAPTURE',
          ...backgroundProvenance(response, 'claude-haiku-4-5-20251001'),
          inputTokens: response.usage?.input_tokens || 0,
          outputTokens: response.usage?.output_tokens || 0,
          cacheCreationInputTokens: response.usage?.cache_creation_input_tokens || 0,
          cacheReadInputTokens: response.usage?.cache_read_input_tokens || 0,
          durationMs: turnDurationMs,
        });
      } catch (costErr) {
        logger.debug('Failed to log turn capture cost', { error: costErr });
      }

      const textContent = response.content.find(block => block.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        throw new Error('No text response from Haiku');
      }

      let jsonText = textContent.text.trim();
      // Strip markdown code blocks if present
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      // Fix common JSON escape issues from Haiku (invalid escapes like \' or control chars)
      jsonText = jsonText
        .replace(/\\'/g, "'")  // \' is not valid JSON escape
        .replace(/[\x00-\x1F\x7F]/g, ' ');  // Control characters

      const parsed = parseJson(jsonText) as TurnSummaryResponse;
      // Strip any emoji from tag (Haiku sometimes includes the emoji in the tag field)
      // Include Variation_Selector for compound emojis like 🏗️ (U+1F3D7 + U+FE0F)
      const tagValue = parsed.tag ?? 'discuss';
      const cleanTag = tagValue.replace(/[\p{Extended_Pictographic}\p{Variation_Selector}\s]+$/u, '').trim();
      return {
        headline: parsed.headline ?? 'Unknown action',
        actions: this.normalizeOutcomeActions(parsed.actions),
        tag: cleanTag || 'discuss',
        icon: parsed.icon ?? '💬',
      };
    } catch (error) {
      logger.error('Failed to summarize turn with Haiku', error);
      // Return a default summary
      return {
        headline: 'Exchange captured',
        actions: ['Outcome unavailable'],
        tag: 'discuss',
        icon: '💬',
      };
    }
  }

  /**
   * Normalize actions to a single outcome line for consistent history UX.
   */
  private normalizeOutcomeActions(actions: unknown): string[] {
    const candidates = Array.isArray(actions)
      ? actions
          .filter((item): item is string => typeof item === 'string')
          .map(item => item.trim())
          .filter(item => item.length > 0)
      : [];

    if (candidates.length === 0) {
      return ['Outcome unavailable'];
    }

    // Prefer the final action when multiple are provided; it tends to reflect the end result.
    const outcome = candidates[candidates.length - 1];
    return [this.truncate(outcome, 220)];
  }

  /**
   * Resolve the message UUID that anchors a given turn number.
   * Returns the human user message that starts that turn.
   */
  async getTurnAnchorMessageId(sessionId: string, turnNumber: number): Promise<string | null> {
    if (!Number.isFinite(turnNumber) || turnNumber < 1) {
      return null;
    }

    // Check harness event storage first — IDs derive from event seq numbers.
    const unifiedMessages = readMessages(sessionId);
    if (unifiedMessages.length > 0) {
      const unifiedAnchor = this.getTurnAnchorMessageIdFromUnified(unifiedMessages, turnNumber);
      if (unifiedAnchor) {
        return unifiedAnchor;
      }
    }

    // Fallback: resolve via provider JSONL for conv-* sessions.
    if (sessionId.startsWith('conv-')) {
      const providerSessionId = this.sessionInfoService.resolveToProviderSessionId(sessionId);
      if (providerSessionId && providerSessionId !== sessionId) {
        try {
          const { messages: providerMessages } = await this.historyReader.fetchConversationDirect(providerSessionId);
          const providerAnchor = this.getTurnAnchorMessageIdFromConversation(providerMessages, turnNumber);
          if (providerAnchor) {
            return providerAnchor;
          }
        } catch (error) {
          logger.debug('Provider-session turn anchor lookup failed (falling back to canonical)', {
            sessionId: sessionId.slice(0, 8),
            providerSessionId: providerSessionId.slice(0, 8),
            turnNumber,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const { messages } = await this.historyReader.fetchConversationDirect(sessionId);
    return this.getTurnAnchorMessageIdFromConversation(messages, turnNumber);
  }

  private getTurnAnchorMessageIdFromUnified(messages: UnifiedMessage[], turnNumber: number): string | null {
    let currentTurn = 0;
    for (const message of messages) {
      if (message.role === 'user' && this.hasHumanTextUnified(message)) {
        currentTurn += 1;
        if (currentTurn === turnNumber) {
          return message.id;
        }
      }
    }
    return null;
  }

  private getTurnAnchorMessageIdFromConversation(messages: ConversationMessage[], turnNumber: number): string | null {
    let currentTurn = 0;
    for (const message of messages) {
      if (message.type === 'user' && this.hasHumanText(message)) {
        currentTurn += 1;
        if (currentTurn === turnNumber) {
          return message.uuid;
        }
      }
    }
    return null;
  }

  /**
   * Save a turn to the database and update session's last termination reason.
   */
  private async saveTurn(turn: Turn): Promise<void> {
    await this.sessionInfoService.initialize();
    await TurnRepository.getInstance().save({
      id: turn.id,
      session_id: turn.sessionId,
      turn_number: turn.turnNumber,
      timestamp: turn.timestamp,
      headline: turn.headline,
      actions: JSON.stringify(turn.actions),
      tag: turn.tag,
      icon: turn.icon,
      exit_code: turn.exitCode,
      termination_reason: turn.terminationReason,
      tool_count: turn.toolCount,
      incomplete: turn.incomplete ? 1 : 0,
    });

    // Also update the session's last termination reason for sidebar display
    await this.sessionInfoService.setLastTerminationReason(turn.sessionId, turn.terminationReason);
  }

  /**
   * Get all turns for a session.
   */
  async getTurnsForSession(sessionId: string): Promise<Turn[]> {
    await this.sessionInfoService.initialize();
    const rows = await this.getTurnRowsForSession(sessionId);
    return rows.map(this.mapTurnRow);
  }

  private async getTurnRowsForSession(sessionId: string): Promise<TurnRow[]> {
    const canonicalRows = await TurnRepository.getInstance().getForSession(sessionId);
    if (!sessionId.startsWith('conv-')) {
      return canonicalRows;
    }

    const providerSessionId = this.sessionInfoService.resolveToProviderSessionId(sessionId);
    if (!providerSessionId || providerSessionId === sessionId) {
      return canonicalRows;
    }

    const providerRows = await TurnRepository.getInstance().getForSession(providerSessionId);
    if (providerRows.length === 0) {
      return canonicalRows;
    }
    if (canonicalRows.length === 0) {
      return providerRows;
    }

    const canonicalCoverage = new Set(canonicalRows.map((row) => `${row.turn_number}:${row.timestamp}`));
    const providerFullyCovered = providerRows.every((row) =>
      canonicalCoverage.has(`${row.turn_number}:${row.timestamp}`)
    );
    if (providerFullyCovered) {
      return canonicalRows;
    }

    const providerMaxTurn = providerRows.reduce((max, row) => Math.max(max, row.turn_number), 0);
    const providerLatestTimestamp = providerRows.reduce(
      (latest, row) => (row.timestamp > latest ? row.timestamp : latest),
      '',
    );
    let nextTurnNumber = providerMaxTurn;
    const seenCanonicalIds = new Set(providerRows.map((row) => row.id));
    const canonicalByTime = [...canonicalRows].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const merged: TurnRow[] = [...providerRows];

    for (const row of canonicalByTime) {
      if (seenCanonicalIds.has(row.id)) {
        continue;
      }

      if (row.turn_number > providerMaxTurn) {
        merged.push(row);
        nextTurnNumber = Math.max(nextTurnNumber, row.turn_number);
        seenCanonicalIds.add(row.id);
        continue;
      }

      if (row.timestamp > providerLatestTimestamp) {
        nextTurnNumber += 1;
        merged.push({
          ...row,
          turn_number: nextTurnNumber,
        });
        seenCanonicalIds.add(row.id);
      }
    }

    merged.sort((a, b) => {
      if (a.turn_number !== b.turn_number) {
        return a.turn_number - b.turn_number;
      }
      return a.timestamp.localeCompare(b.timestamp);
    });

    return merged;
  }

  /**
   * Map database row to Turn object.
   */
  private mapTurnRow(row: TurnRow): Turn {
    return {
      id: row.id,
      sessionId: row.session_id,
      turnNumber: row.turn_number,
      timestamp: row.timestamp,
      headline: row.headline,
      actions: parseJson(row.actions) as string[],
      tag: row.tag,
      icon: row.icon,
      exitCode: row.exit_code,
      terminationReason: (row.termination_reason as TerminationReason) || 'normal_completion',
      toolCount: row.tool_count,
      incomplete: row.incomplete === 1,
    };
  }

  // ===========================================================================
  // Backfill — capture missing turns on explicit request
  // ===========================================================================

  /**
   * Backfill missing turns for a single session.
   * Compares stored turn count against actual turn count from messages,
   * then captures any missing turns via Haiku.
   * Returns the number of newly captured turns.
   */
  async backfillMissingTurns(sessionId: string): Promise<number> {
    const existingTurns = await this.getTurnsForSession(sessionId);
    const existingCount = existingTurns.length;

    // Get messages from unified store or JSONL fallback
    const unifiedMessages = readMessages(sessionId);
    let allTurnData: Array<{ userMessage: string; claudeResponse: string; toolUses: string[] }>;

    if (unifiedMessages.length > 0) {
      allTurnData = this.extractAllTurnsFromUnified(unifiedMessages);
    } else {
      const { messages } = await this.historyReader.fetchConversationDirect(sessionId);
      if (messages.length === 0) return 0;
      allTurnData = this.extractAllTurnsFromConversation(messages);
    }

    // Only process turns we haven't captured yet
    const missingTurns = allTurnData.slice(existingCount);
    if (missingTurns.length === 0) return 0;

    logger.info('Backfilling missing turns', {
      sessionId: sessionId.slice(0, 8),
      existingCount,
      totalTurns: allTurnData.length,
      toBackfill: missingTurns.length,
    });

    const newlyCaptures: Turn[] = [];

    for (let i = 0; i < missingTurns.length; i++) {
      const turnNumber = existingCount + i + 1;
      const turnData = missingTurns[i];

      // Build context from existing + newly captured turns
      const contextTurns = [...existingTurns, ...newlyCaptures].slice(-5);

      const summary = await this.summarizeTurn(
        turnData.userMessage,
        turnData.claudeResponse,
        turnData.toolUses,
        contextTurns,
        sessionId
      );

      const turn: Turn = {
        id: `turn-${sessionId.slice(0, 8)}-${turnNumber}-${Date.now()}`,
        sessionId,
        turnNumber,
        timestamp: new Date().toISOString(),
        headline: summary.headline,
        actions: summary.actions,
        tag: summary.tag,
        icon: summary.icon,
        exitCode: 0,
        terminationReason: 'normal_completion',
        toolCount: turnData.toolUses.length,
        incomplete: false,
      };

      await this.saveTurn(turn);
      newlyCaptures.push(turn);
    }

    logger.info('Backfill complete', {
      sessionId: sessionId.slice(0, 8),
      captured: newlyCaptures.length,
    });

    return newlyCaptures.length;
  }

  /**
   * Backfill turns for all active (non-archived) sessions.
   * Intended for explicit maintenance/backfill requests.
   */
  async backfillActiveSessions(): Promise<{ sessionsProcessed: number; turnsCapture: number }> {
    const sessionIds = this.sessionInfoService.getNonArchivedSessionIds();
    logger.info('Starting turn backfill for active sessions', { sessionCount: sessionIds.length });

    let totalTurns = 0;
    let sessionsProcessed = 0;

    for (const sessionId of sessionIds) {
      try {
        const captured = await this.backfillMissingTurns(sessionId);
        if (captured > 0) {
          sessionsProcessed++;
          totalTurns += captured;
        }
      } catch (err) {
        logger.warn('Failed to backfill session', {
          sessionId: sessionId.slice(0, 8),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('Turn backfill complete', { sessionsProcessed, totalTurns });
    return { sessionsProcessed, turnsCapture: totalTurns };
  }

  /**
   * Extract ALL turns from unified messages.
   * Each turn is a human user message + everything until the next human message.
   */
  private extractAllTurnsFromUnified(
    messages: UnifiedMessage[]
  ): Array<{ userMessage: string; claudeResponse: string; toolUses: string[] }> {
    // Find all human message indices
    const humanIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'user' && this.hasHumanTextUnified(messages[i])) {
        humanIndices.push(i);
      }
    }

    const turns: Array<{ userMessage: string; claudeResponse: string; toolUses: string[] }> = [];

    for (let t = 0; t < humanIndices.length; t++) {
      const startIdx = humanIndices[t];
      const endIdx = t + 1 < humanIndices.length ? humanIndices[t + 1] : messages.length;

      // Extract user message text
      let userMessage = '';
      for (const block of messages[startIdx].content) {
        if (block.type === 'text') userMessage += block.text + '\n';
      }

      // Process response messages (between this human msg and the next)
      const responseSlice = messages.slice(startIdx + 1, endIdx);
      const toolUses: string[] = [];
      const pendingTools: Map<string, { name: string; input: string }> = new Map();
      let claudeResponse = '';

      for (const msg of responseSlice) {
        for (const block of msg.content) {
          if (msg.role === 'assistant') {
            if (block.type === 'text') {
              claudeResponse += block.text + '\n';
            } else if (block.type === 'tool_use') {
              let inputSummary = '';
              const input = block.input;
              if (block.name === 'Edit' || block.name === 'Write' || block.name === 'Read') {
                inputSummary = (input.file_path as string) || '';
              } else if (block.name === 'Bash') {
                inputSummary = this.truncate((input.command as string) || '', 60);
              } else if (block.name === 'Grep') {
                inputSummary = `"${String(input.pattern ?? '')}"`;
              } else {
                inputSummary = this.truncate(JSON.stringify(input), 60);
              }
              pendingTools.set(block.id, { name: block.name, input: inputSummary });
            }
          } else if (msg.role === 'user' && block.type === 'tool_result') {
            const tool = pendingTools.get(block.toolUseId);
            if (tool) {
              const resultSummary = this.summarizeToolResultUnified(tool.name, block.output, block.isError);
              toolUses.push(`${tool.name}(${tool.input}) → ${resultSummary}`);
              pendingTools.delete(block.toolUseId);
            }
          }
        }
      }

      for (const [_id, tool] of pendingTools) {
        toolUses.push(`${tool.name}(${tool.input}) → (no result)`);
      }

      turns.push({
        userMessage: this.truncate(userMessage.trim(), 2000),
        claudeResponse: this.truncate(claudeResponse.trim(), 2000),
        toolUses,
      });
    }

    return turns;
  }

  /**
   * Extract ALL turns from legacy ConversationMessage format.
   */
  private extractAllTurnsFromConversation(
    messages: ConversationMessage[]
  ): Array<{ userMessage: string; claudeResponse: string; toolUses: string[] }> {
    // Find all human message indices
    const humanIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].type === 'user' && this.hasHumanText(messages[i])) {
        humanIndices.push(i);
      }
    }

    const turns: Array<{ userMessage: string; claudeResponse: string; toolUses: string[] }> = [];

    for (let t = 0; t < humanIndices.length; t++) {
      const startIdx = humanIndices[t];
      const endIdx = t + 1 < humanIndices.length ? humanIndices[t + 1] : messages.length;

      // Extract user message
      const userMsg = messages[startIdx];
      let userMessage = '';
      const userContent = userMsg.message?.content;
      if (typeof userContent === 'string') {
        userMessage = userContent;
      } else if (Array.isArray(userContent)) {
        userMessage = userContent
          .filter((block): block is { type: 'text'; text: string } =>
            typeof block === 'object' && block !== null && block.type === 'text')
          .map(block => block.text)
          .join('\n');
      }

      // Process response messages
      const responseSlice = messages.slice(startIdx + 1, endIdx);
      const toolUses: string[] = [];
      const pendingTools: Map<string, { name: string; input: string }> = new Map();
      let claudeResponse = '';

      for (const msg of responseSlice) {
        const content = msg.message?.content;
        if (!Array.isArray(content)) {
          if (msg.type === 'assistant' && typeof content === 'string') {
            claudeResponse += content + '\n';
          }
          continue;
        }

        for (const block of content) {
          if (typeof block !== 'object' || block === null) continue;

          if (msg.type === 'assistant') {
            if (block.type === 'text' && 'text' in block) {
              claudeResponse += (block as { type: 'text'; text: string }).text + '\n';
            } else if (block.type === 'tool_use' && 'name' in block && 'id' in block) {
              const toolBlock = block as { type: 'tool_use'; id: string; name: string; input: unknown };
              let inputSummary = '';
              const input = toolBlock.input as Record<string, unknown>;
              if (toolBlock.name === 'Edit' || toolBlock.name === 'Write' || toolBlock.name === 'Read') {
                inputSummary = (input.file_path as string) || '';
              } else if (toolBlock.name === 'Bash') {
                inputSummary = this.truncate((input.command as string) || '', 60);
              } else if (toolBlock.name === 'Grep') {
                inputSummary = `"${String(input.pattern ?? '')}"`;
              } else {
                inputSummary = this.truncate(JSON.stringify(input), 60);
              }
              pendingTools.set(toolBlock.id, { name: toolBlock.name, input: inputSummary });
            }
          } else if (msg.type === 'user' && block.type === 'tool_result' && 'tool_use_id' in block) {
            const resultBlock = block as { type: 'tool_result'; tool_use_id: string; content?: unknown };
            const tool = pendingTools.get(resultBlock.tool_use_id);
            if (tool) {
              const resultSummary = this.summarizeToolResult(tool.name, resultBlock.content);
              toolUses.push(`${tool.name}(${tool.input}) → ${resultSummary}`);
              pendingTools.delete(resultBlock.tool_use_id);
            }
          }
        }
      }

      for (const [_id, tool] of pendingTools) {
        toolUses.push(`${tool.name}(${tool.input}) → (no result)`);
      }

      turns.push({
        userMessage: this.truncate(userMessage, 2000),
        claudeResponse: this.truncate(claudeResponse.trim(), 2000),
        toolUses,
      });
    }

    return turns;
  }

  private truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen - 3) + '...';
  }
}
