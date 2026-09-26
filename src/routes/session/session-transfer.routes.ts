/**
 * Session Transfer Routes (Export / Import)
 *
 * Export: GET /api/sessions/export/:conversationId — downloads a .lattice JSON bundle
 * Import: POST /api/sessions/import — accepts a JSON bundle, creates a read-only session
 */

import { Router } from 'express';
import { asyncHandler } from '@/middleware/error-handler.js';
import { LatticeError, type ConversationMessage } from '@/types/index.js';
import type { SessionInsights } from '@/types/insights.js';
import { SessionInfoService } from '@/services/sessions/session-info-service.js';
import type { InsightsRecord } from '@/services/insights/insights-engine.js';
import { ConversationService, type Provider } from '@/services/sessions/conversation-service.js';
import { readMessages } from '@/harness/event-message-reader.js';
import { mapUnifiedMessageToConversationMessage } from '@/services/sessions/unified-message-mapper.js';
import { convertMessagesToEvents } from '@/harness/history-backfill.js';
import { SqliteEventStorageAdapter } from '@/harness/sqlite-event-storage.js';
import { DatabaseProvider } from '@/services/infrastructure/database-provider.js';
import type { ClaudeHistoryReader } from '@/services/sessions/claude-history-reader.js';
import { InsightsEngine } from '@/services/insights/insights-engine.js';
import { createLogger } from '@/services/infrastructure/logger.js';
import { TurnRepository, type TurnRecord } from '@/services/sessions/turn-repository.js';
import type { UnifiedContentBlock } from '@/types/unified-messages.js';
import { parseJson } from '../../utils/json.js';

const logger = createLogger('SessionTransferRoutes');

// Bundle schema version — increment when the format changes
const BUNDLE_VERSION = 1;

/** Build a descriptive name for an imported session */
function formatImportName(bundle: SessionExportBundle): string {
  const originalName = bundle.session?.name;
  const mission = bundle.insights?.context?.mission;
  const label = originalName || mission || 'Shared session';
  const date = new Date(bundle.exportedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${label} (shared ${date})`;
}

/** The shape of an exported .lattice session bundle */
export interface SessionExportBundle {
  version: number;
  exportedAt: string;
  latticeVersion: string;
  session: {
    name: string | null;
    createdAt: string;
    updatedAt: string;
    identityImage: string | null;
    permissionMode: string | null;
    workingDirectory: string;
  };
  insights: SessionInsights | null;
  turns: Array<{
    turnNumber: number;
    timestamp: string;
    headline: string;
    actions: string[];
    tag: string;
    icon: string;
  }>;
  messages: ConversationMessage[];
}

export function createSessionTransferRoutes(_deps: {
  historyReader: ClaudeHistoryReader;
}): Router {
  const router = Router();
  const sessionInfoService = SessionInfoService.getInstance();
  const conversationService = ConversationService.getInstance();
  const insightsEngine = InsightsEngine.getInstance();

  // ==========================================================================
  // GET /export/:conversationId — Export a session as a downloadable JSON bundle
  // ==========================================================================
  router.get('/export/:conversationId', asyncHandler(async (req, res) => {
    const { conversationId } = req.params;

    const conversation = conversationService.getConversation(conversationId);
    if (!conversation) {
      throw new LatticeError('CONVERSATION_NOT_FOUND', `Conversation ${conversationId} not found`, 404);
    }

    // Resolve messages from harness event storage
    const unifiedMessages = readMessages(conversationId);
    const resolved = {
      messages: unifiedMessages.map(m => mapUnifiedMessageToConversationMessage(m, conversationId)),
      duplicateMessagesDropped: 0,
    };

    // Get session metadata
    const sessionInfo = sessionInfoService.getSessionInfoSync(conversationId);
    const firstSegment = conversation.segments[0];
    const segmentInfo = firstSegment
      ? sessionInfoService.getSessionInfoSync(firstSegment.providerSessionId)
      : null;
    const info = sessionInfo || segmentInfo;

    // Get insights
    let insights: SessionInsights | null = null;
    try {
      const cached = await insightsEngine.getCachedInsightsForSessions([conversationId]);
      insights = cached.get(conversationId) || null;
    } catch {
      // Insights are optional in export
    }

    // Get turns
    let turns: SessionExportBundle['turns'] = [];
    try {
      const turnRecords = await TurnRepository.getInstance().getForSession(conversationId);
      turns = turnRecords.map(t => ({
        turnNumber: t.turn_number,
        timestamp: t.timestamp,
        headline: t.headline,
        actions: parseJson(t.actions || '[]') as string[],
        tag: t.tag,
        icon: t.icon,
      }));
    } catch {
      // Turns are optional in export
    }

    const bundle: SessionExportBundle = {
      version: BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      latticeVersion: process.env.npm_package_version || '1.0.0',
      session: {
        name: info?.custom_name || null,
        createdAt: info?.created_at || conversation.createdAt,
        updatedAt: info?.updated_at || conversation.updatedAt,
        identityImage: info?.identity_image || null,
        permissionMode: info?.permission_mode || null,
        workingDirectory: conversation.workingDirectory,
      },
      insights,
      turns,
      messages: resolved.messages,
    };

    const filename = `${(info?.custom_name || conversationId).replace(/[^a-zA-Z0-9_-]/g, '_')}.lattice.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(bundle);
  }));

  // ==========================================================================
  // POST /import — Import a session bundle as a read-only conversation
  // ==========================================================================
  router.post('/import', asyncHandler(async (req, res) => {
    const bundle = req.body as SessionExportBundle;

    // Validate bundle
    if (!bundle || typeof bundle.version !== 'number') {
      throw new LatticeError('INVALID_BUNDLE', 'Invalid session bundle: missing version', 400);
    }
    if (bundle.version > BUNDLE_VERSION) {
      throw new LatticeError('UNSUPPORTED_VERSION', `Bundle version ${bundle.version} is newer than supported (${BUNDLE_VERSION})`, 400);
    }
    if (!Array.isArray(bundle.messages) || bundle.messages.length === 0) {
      throw new LatticeError('INVALID_BUNDLE', 'Invalid session bundle: messages array is empty or missing', 400);
    }

    const now = new Date().toISOString();

    // 1. Create the conversation record
    const { conversationId } = conversationService.createConversation({
      workingDirectory: bundle.session?.workingDirectory || '/imported',
      provider: 'claude' as Provider,
      providerSessionId: `imported-${Date.now()}`,
      initialPrompt: bundle.messages[0]?.type === 'user'
        ? extractTextPreview(bundle.messages[0])
        : 'Imported session',
    });

    logger.info('Importing session', {
      conversationId,
      messageCount: bundle.messages.length,
      hasTurns: bundle.turns?.length > 0,
      hasInsights: !!bundle.insights,
    });

    // 2. Store messages as harness events
    const events = convertMessagesToEvents(conversationId, bundle.messages);
    const db = DatabaseProvider.getInstance().getDb();
    const eventStorage = new SqliteEventStorageAdapter(db);
    for (const event of events) {
      eventStorage.write(event);
    }

    // 3. Create session info record (marked as imported)
    await sessionInfoService.updateSessionInfo(conversationId, {
      custom_name: formatImportName(bundle),
      archived: false,
      imported_at: now,
      permission_mode: bundle.session?.permissionMode || 'default',
      created_at: bundle.session?.createdAt || now,
      conversation_id: conversationId,
    });

    // 4. Store identity image if present
    if (bundle.session?.identityImage) {
      await sessionInfoService.setIdentityImage(conversationId, bundle.session.identityImage);
    }

    // 5. Store insights if present
    if (bundle.insights) {
      const cachedInsights: InsightsRecord = {
        session_id: conversationId,
        context: bundle.insights.context,
        tags: bundle.insights.tags,
        theme: bundle.insights.theme,
        purpose: bundle.insights.purpose,
        computed_at: bundle.insights.computedAt || now,
        stale: false,
        message_count: bundle.messages.length,
      };
      await insightsEngine.setInsightsRecord(cachedInsights);
    }

    // 6. Store turns if present
    if (bundle.turns && bundle.turns.length > 0) {
      for (const turn of bundle.turns) {
        const turnRecord: TurnRecord = {
          id: `imported-${conversationId}-${turn.turnNumber}`,
          session_id: conversationId,
          turn_number: turn.turnNumber,
          timestamp: turn.timestamp,
          headline: turn.headline,
          actions: JSON.stringify(turn.actions),
          tag: turn.tag,
          icon: turn.icon,
          exit_code: null,
          termination_reason: 'normal_completion',
          tool_count: 0,
          incomplete: 0,
        };
        await TurnRepository.getInstance().save(turnRecord);
      }
    }

    res.json({
      conversationId,
      messageCount: bundle.messages.length,
      imported: true,
    });
  }));

  return router;
}

function extractTextPreview(msg: ConversationMessage): string {
  const m = msg.message;
  if (typeof m === 'string') return (m as string).slice(0, 100);
  if (m && 'content' in m) {
    const content = m.content;
    if (typeof content === 'string') return content.slice(0, 100);
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
          return block.text.slice(0, 100);
        }
      }
    }
  }
  return 'Imported session';
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- future use
function normalizeMessageContent(msg: ConversationMessage): UnifiedContentBlock[] {
  const m = msg.message;
  if (m && typeof m === 'object' && 'content' in m && Array.isArray(m.content)) {
    // Anthropic Message — content blocks already have type/text shape
    return m.content as UnifiedContentBlock[];
  }
  if (m && typeof m === 'object' && 'content' in m && typeof m.content === 'string') {
    return [{ type: 'text' as const, text: m.content }];
  }
  // Fallback
  const text = typeof m === 'string' ? m : JSON.stringify(m);
  return [{ type: 'text' as const, text }];
}
