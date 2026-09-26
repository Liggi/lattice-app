import { Router } from 'express';
import { LatticeError, PermissionDecisionRequest, PermissionDecisionResponse } from '@/types/index.js';
import { RequestWithRequestId } from '@/types/express.js';
import { asyncHandler } from '@/middleware/error-handler.js';
import { PermissionTracker } from '@/services/permission-tracker.js';
import { createLogger } from '@/services/infrastructure/logger.js';
import { isAllowedByPatterns, suggestPatterns } from '@/services/permission-pattern-matcher.js';
import { anthropicService } from '@/services/insights/anthropic-service.js';
import { getPermissionEventLog } from '@/services/permission-event-log.js';
import { ClaudeSettingsService } from '@/services/infrastructure/claude-settings-service.js';
import { ConversationService } from '@/services/sessions/conversation-service.js';
import { SessionInfoService } from '@/services/sessions/session-info-service.js';
import { allowGeneration } from '@/services/infrastructure/generation-gates.js';

const claudeSettingsService = ClaudeSettingsService.getInstance();
const conversationService = ConversationService.getInstance();
const sessionInfoService = SessionInfoService.getInstance();

// Session-level allowlists (in-memory, keyed by streamingId, stores patterns)
const sessionAllowlists = new Map<string, Set<string>>();

// Request body types for type-safe route handlers
interface NotifyRequestBody {
  toolName: string;
  toolInput?: Record<string, unknown>;
  streamingId?: string;
}

interface PermissionRequestHookBody {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

interface PreToolUseHookBody {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

interface CompactHookBody {
  session_id?: string;
  phase?: string;
  trigger?: 'auto' | 'manual' | string;
}

interface SuggestPatternsRequestBody {
  toolName: string;
  toolInput?: Record<string, unknown>;
  useLLM?: boolean;
}

interface SessionAllowlistRequestBody {
  pattern?: string;
  toolName?: string;  // Legacy support
  streamingId: string;
}

interface GlobalAllowlistRequestBody {
  pattern?: string;
  toolName?: string;  // Legacy support
}

// Load global allowlist from Claude's native settings
function loadGlobalAllowlist(): string[] {
  return claudeSettingsService.getToolPermissionsAllow();
}

// Save pattern to Claude's native settings.json allowlist
function saveGlobalAllowlist(patterns: string[]): void {
  claudeSettingsService.setToolPermissionsAllow(patterns);
}

/**
 * Check if a tool invocation is allowed by allowlists.
 * Now supports pattern matching like "Bash(npm *)", "Write(src/**)".
 *
 * @returns Object with matching pattern and source if allowed, null otherwise
 */
export function isToolAllowed(
  toolName: string,
  toolInput: Record<string, unknown>,
  streamingId?: string
): { pattern: string; source: 'global' | 'session' } | null {
  // Check global allowlist with pattern matching
  const globalAllowlist = loadGlobalAllowlist();
  const globalMatch = isAllowedByPatterns(globalAllowlist, toolName, toolInput);
  if (globalMatch) {
    return { pattern: globalMatch, source: 'global' };
  }

  // Check session allowlist with pattern matching
  if (streamingId) {
    const sessionAllowlist = sessionAllowlists.get(streamingId);
    if (sessionAllowlist) {
      const sessionMatch = isAllowedByPatterns(Array.from(sessionAllowlist), toolName, toolInput);
      if (sessionMatch) {
        return { pattern: sessionMatch, source: 'session' };
      }
    }
  }

  return null;
}

// Add pattern to session allowlist
export function addToSessionAllowlist(streamingId: string, pattern: string): void {
  let allowlist = sessionAllowlists.get(streamingId);
  if (!allowlist) {
    allowlist = new Set();
    sessionAllowlists.set(streamingId, allowlist);
  }
  allowlist.add(pattern);
}

// Add pattern to global allowlist
export function addToGlobalAllowlist(pattern: string): void {
  const allowlist = loadGlobalAllowlist();
  if (!allowlist.includes(pattern)) {
    allowlist.push(pattern);
    saveGlobalAllowlist(allowlist);
  }
}

// Re-export suggestPatterns for use by frontend
export { suggestPatterns } from '@/services/permission-pattern-matcher.js';

/**
 * Resolve the `permission_mode` for a Claude Code provider-session UUID
 * (the value CC puts in hook payload `session_id`).
 *
 * `getSessionInfoSync(sessionId)` is keyed by Lattice's canonical
 * conversation ID (`conv-*`) for the canonical row, so a raw provider
 * UUID lookup typically misses (returns `null`). The session row in
 * conversation_segments holds the mapping; resolve via
 * `getConversationByProviderSession` first, then read merged session
 * info — same pattern as `permission.routes.ts:575`.
 */
function getSessionInfoForHookSession(sessionId?: string) {
  if (!sessionId) {
    return null;
  }

  const mappedConversation = conversationService.getConversationByProviderSession(sessionId);
  if (mappedConversation?.conversation.conversationId) {
    const merged = sessionInfoService.getMergedSessionInfo(
      mappedConversation.conversation.conversationId,
      sessionId,
    );
    if (merged) {
      return merged;
    }
  }

  return sessionInfoService.getSessionInfoSync(sessionId);
}

function getPermissionModeForHookSession(sessionId?: string): string | undefined {
  return getSessionInfoForHookSession(sessionId)?.permission_mode;
}

function shouldBridgePreToolUsePermission(sessionId?: string): boolean {
  return getPermissionModeForHookSession(sessionId) === 'default';
}

export function createPermissionRoutes(
  permissionTracker: PermissionTracker,
): Router {
  const router = Router();
  const logger = createLogger('PermissionRoutes');

  const waitForDecision = async (requestId: string, timeoutMs = 60 * 60 * 1000): Promise<{
    status: 'approved' | 'denied' | 'timeout';
    modifiedInput?: Record<string, unknown>;
    denyReason?: string;
  }> => {
    const existing = permissionTracker.getPermissionRequest(requestId);
    if (!existing) {
      return { status: 'denied', denyReason: 'Permission request missing' };
    }
    if (existing.status === 'approved') {
      return { status: 'approved', modifiedInput: existing.modifiedInput };
    }
    if (existing.status === 'denied') {
      return { status: 'denied', denyReason: existing.denyReason };
    }

    return new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        permissionTracker.removeListener('permission_updated', onUpdated);
        resolve({ status: 'timeout' });
      }, timeoutMs);

      const onUpdated = (updated: { id: string; status: 'pending' | 'approved' | 'denied'; modifiedInput?: Record<string, unknown>; denyReason?: string }) => {
        if (resolved || updated.id !== requestId || updated.status === 'pending') {
          return;
        }
        resolved = true;
        clearTimeout(timer);
        permissionTracker.removeListener('permission_updated', onUpdated);
        resolve({
          status: updated.status,
          modifiedInput: updated.modifiedInput,
          denyReason: updated.denyReason,
        });
      };

      permissionTracker.on('permission_updated', onUpdated);
    });
  };

  // Notify endpoint - called by MCP server when permission is requested
  // Returns auto-approved if tool invocation matches an allowlist pattern
  router.post('/notify', asyncHandler(async (req: RequestWithRequestId<NotifyRequestBody>, res) => {
    const requestId = req.requestId;
    const permissionLog = getPermissionEventLog();
    logger.debug('Permission notification received', {
      requestId,
      body: req.body
    });

    const { toolName, toolInput, streamingId } = req.body;

    if (!toolName) {
      throw new LatticeError('MISSING_TOOL_NAME', 'toolName is required', 400);
    }

    // Auto-approve EnterPlanMode — it's a harmless mode transition (Claude is just switching to planning).
    // ExitPlanMode is NOT auto-approved: it needs user confirmation, but gets special UI in the frontend.
    if (toolName === 'EnterPlanMode') {
      permissionLog.autoApproved({
        toolName,
        toolInput,
        streamingId,
        matchedPattern: 'EnterPlanMode (plan mode transition)',
        patternSource: 'global',
      });
      res.json({ success: true, id: 'auto-approved', autoApproved: true, matchedPattern: 'EnterPlanMode' });
      return;
    }

    // Check if tool invocation is auto-allowed by any pattern (session or global)
    const match = isToolAllowed(toolName, toolInput || {}, streamingId);
    if (match) {
      // Log auto-approval with structured event
      permissionLog.autoApproved({
        toolName,
        toolInput,
        streamingId,
        matchedPattern: match.pattern,
        patternSource: match.source,
      });

      res.json({ success: true, id: 'auto-approved', autoApproved: true, matchedPattern: match.pattern });
      return;
    }

    // Add permission request with the provided streamingId
    const request = permissionTracker.addPermissionRequest(toolName, toolInput ?? {}, streamingId);

    // Log permission request with structured event
    permissionLog.request({
      toolName,
      toolInput,
      streamingId,
      permissionRequestId: request.id,
    });

    res.json({ success: true, id: request.id });
  }));

  router.post('/hooks/permission-request', asyncHandler(async (req: RequestWithRequestId<PermissionRequestHookBody>, res) => {
    const hookBody = req.body || {};
    const toolName = hookBody.tool_name;
    const toolInput = hookBody.tool_input || {};
    const sessionId = hookBody.session_id;
    const eventName = hookBody.hook_event_name;

    if (eventName && eventName !== 'PermissionRequest') {
      throw new LatticeError('INVALID_HOOK_EVENT', `Unexpected hook event: ${eventName}`, 400);
    }
    if (!toolName) {
      throw new LatticeError('MISSING_TOOL_NAME', 'tool_name is required', 400);
    }

    // When the session was spawned with `--permission-prompt-tool stdio`
    // (any non-default permission mode — see process-daemon.ts#applyPermissionMode),
    // the SDK permission bridge owns the decision via `can_use_tool`
    // control_request. CC fires this HTTP hook in parallel with the SDK
    // request (structuredIO.ts:577–611) and races them; both calling
    // `addPermissionRequest` produces two banners and a stuck UI.
    // Returning {} means "no decision from this hook" — CC's hook loop
    // (PermissionContext.ts:222–262) then awaits the SDK response.
    const mode = getPermissionModeForHookSession(sessionId);
    if (mode && mode !== 'default') {
      logger.debug('PermissionRequest hook passing through to SDK bridge', {
        sessionId: sessionId ? sessionId.slice(0, 8) : undefined,
        mode,
      });
      res.json({});
      return;
    }

    const streamingId = sessionId
      ? permissionTracker.resolveStreamingIdForSession(sessionId)
      : undefined;

    const permissionRequest = permissionTracker.addPermissionRequest(toolName, toolInput, streamingId);
    const decision = await waitForDecision(permissionRequest.id);

    if (decision.status === 'approved') {
      res.json({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'allow',
            ...(decision.modifiedInput ? { updatedInput: decision.modifiedInput } : {}),
          },
        },
      });
      return;
    }

    if (decision.status === 'timeout') {
      res.json({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'deny',
            message: 'Permission request timed out waiting for user decision.',
          },
        },
      });
      return;
    }

    res.json({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'deny',
          message: decision.denyReason || 'Permission denied by user.',
        },
      },
    });
  }));

  router.post('/hooks/pre-tool-use', asyncHandler(async (req: RequestWithRequestId<PreToolUseHookBody>, res) => {
    const hookBody = req.body || {};
    const toolName = hookBody.tool_name;
    const toolInput = hookBody.tool_input || {};
    const sessionId = hookBody.session_id;
    const eventName = hookBody.hook_event_name;

    if (eventName && eventName !== 'PreToolUse') {
      throw new LatticeError('INVALID_HOOK_EVENT', `Unexpected hook event: ${eventName}`, 400);
    }
    if (!toolName) {
      throw new LatticeError('MISSING_TOOL_NAME', 'tool_name is required', 400);
    }

    const streamingId = sessionId
      ? permissionTracker.resolveStreamingIdForSession(sessionId)
      : undefined;

    // Auto-approve EnterPlanMode before permission prompts.
    if (toolName === 'EnterPlanMode') {
      res.json({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
      return;
    }

    const match = isToolAllowed(toolName, toolInput, streamingId);
    if (match) {
      res.json({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
      return;
    }

    // In non-ASK modes (acceptEdits, bypassPermissions), Lattice returns no opinion
    // from PreToolUse, deferring to Claude Code's built-in permission logic.
    //
    // Empirical finding (v2.1.70): Claude Code does NOT fire PermissionRequest hooks
    // in -p mode with acceptEdits. The acceptEdits mode auto-approves all tool calls
    // in non-interactive mode — it's functionally equivalent to bypassPermissions
    // when running via -p. Only the interactive terminal enforces the edit-only
    // auto-approve boundary.
    //
    // For ASK (default) mode, we bridge approval directly here in PreToolUse because
    // we want every tool call to prompt, not just the ones Claude considers elevated.
    if (!shouldBridgePreToolUsePermission(sessionId)) {
      res.json({});
      return;
    }

    const permissionRequest = permissionTracker.addPermissionRequest(toolName, toolInput, streamingId);
    const decision = await waitForDecision(permissionRequest.id);

    if (decision.status === 'approved') {
      res.json({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
      return;
    }

    res.json({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
  }));

  router.post('/hooks/compact', asyncHandler(async (req: RequestWithRequestId<CompactHookBody>, res) => {
    res.json({ ok: true });
  }));

  // Get suggested patterns for a tool invocation
  // Called by frontend to show pattern options in the permission banner
  // Uses LLM (Haiku) for intelligent suggestions, with heuristic fallback
  router.post('/suggest-patterns', asyncHandler(async (req: RequestWithRequestId<SuggestPatternsRequestBody>, res) => {
    const requestId = req.requestId;
    const permissionLog = getPermissionEventLog();
    const startTime = Date.now();

    const { toolName, toolInput, useLLM = true } = req.body;
    if (!toolName) {
      throw new LatticeError('MISSING_TOOL_NAME', 'toolName is required', 400);
    }

    let patterns: string[];
    let source: 'llm' | 'heuristic';

    // Try LLM-powered suggestions first when enabled and configured. Falls
    // through to the heuristic patterns when the switch is off, so the prompt
    // still offers something rather than erroring.
    if (useLLM && allowGeneration('permissionPatterns') && anthropicService.isConfigured()) {
      try {
        const llmPatterns = await anthropicService.suggestPermissionPatterns(
          toolName,
          toolInput || {}
        );

        if (llmPatterns.length > 0) {
          patterns = llmPatterns;
          source = 'llm';

          // Log structured event
          permissionLog.patternSuggest({
            toolName,
            toolInput,
            suggestedPatterns: patterns,
            suggestionSource: 'llm',
            durationMs: Date.now() - startTime,
          });

          res.json({ patterns, source });
          return;
        }
      } catch (llmError) {
        logger.warn('LLM pattern suggestion failed, falling back to heuristic', {
          requestId,
          error: llmError instanceof Error ? llmError.message : String(llmError)
        });
      }
    }

    // Fallback to heuristic-based suggestions
    patterns = suggestPatterns(toolName, toolInput || {});
    source = 'heuristic';

    // Log structured event
    permissionLog.patternSuggest({
      toolName,
      toolInput,
      suggestedPatterns: patterns,
      suggestionSource: 'heuristic',
      durationMs: Date.now() - startTime,
    });

    res.json({ patterns, source });
  }));

  // Add pattern to session allowlist
  // Accepts either `pattern` (new) or `toolName` (legacy, for backwards compat)
  router.post('/allowlist/session', asyncHandler(async (req: RequestWithRequestId<SessionAllowlistRequestBody>, res) => {
    const permissionLog = getPermissionEventLog();

    const { pattern, toolName, streamingId } = req.body;
    const effectivePattern = pattern || toolName; // Support both new and old API
    if (!effectivePattern || !streamingId) {
      throw new LatticeError('MISSING_PARAMS', 'pattern (or toolName) and streamingId are required', 400);
    }
    addToSessionAllowlist(streamingId, effectivePattern);

    // Log structured event
    permissionLog.allowlistAdd({
      pattern: effectivePattern,
      scope: 'session',
      streamingId,
    });

    res.json({ success: true, pattern: effectivePattern });
  }));

  // Add pattern to global allowlist
  // Accepts either `pattern` (new) or `toolName` (legacy, for backwards compat)
  router.post('/allowlist/global', asyncHandler(async (req: RequestWithRequestId<GlobalAllowlistRequestBody>, res) => {
    const permissionLog = getPermissionEventLog();

    const { pattern, toolName } = req.body;
    const effectivePattern = pattern || toolName; // Support both new and old API
    if (!effectivePattern) {
      throw new LatticeError('MISSING_PARAMS', 'pattern (or toolName) is required', 400);
    }
    addToGlobalAllowlist(effectivePattern);

    // Log structured event
    permissionLog.allowlistAdd({
      pattern: effectivePattern,
      scope: 'global',
    });

    res.json({ success: true, pattern: effectivePattern });
  }));

  router.get('/allowlist', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { streamingId } = req.query as { streamingId?: string };
    const global = loadGlobalAllowlist();
    const session = streamingId ? Array.from(sessionAllowlists.get(streamingId) || []) : [];
    res.json({ global, session });
  }));

  // List permissions
  router.get('/', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { streamingId, sessionId, status } = req.query as {
      streamingId?: string;
      sessionId?: string;
      status?: 'pending' | 'approved' | 'denied';
    };

    let permissions = permissionTracker.getPermissionRequests({ streamingId, status });
    if (sessionId) {
      permissions = permissions.filter((permission) => {
        if (permission.sessionId === sessionId) {
          return true;
        }
        if (!permission.sessionId) {
          return false;
        }
        const conversation = conversationService.getConversationByProviderSession(permission.sessionId);
        return conversation?.conversation.conversationId === sessionId;
      });
    }

    // Resolve conversationId for each permission so the frontend can map to sidebar sessions
    const enriched = permissions.map(p => {
      if (p.sessionId) {
        const conv = conversationService.getConversationByProviderSession(p.sessionId);
        if (conv) {
          return { ...p, conversationId: conv.conversation.conversationId };
        }
      }
      return p;
    });

    if (enriched.length > 0) {
      logger.debug('Permissions poll returned results', {
        requestId: req.requestId,
        count: enriched.length,
        filter: { streamingId, sessionId, status }
      });
    }

    res.json({ permissions: enriched });
  }));

  // Permission decision endpoint - called by frontend to approve/deny permissions
  router.post('/:requestId/decision', asyncHandler(async (req: RequestWithRequestId<PermissionDecisionRequest>, res) => {
    const requestIdHeader = req.requestId;
    const { requestId } = req.params;
    const decisionRequest = req.body;
    const permissionLog = getPermissionEventLog();
    const startTime = Date.now();

    // Log at info level for visibility in debugging hangs
    logger.info('Permission decision received', {
      requestId: requestIdHeader,
      permissionRequestId: requestId.slice(0, 8),
      action: decisionRequest.action,
    });

    // Validate request body
    if (!decisionRequest.action || !['approve', 'deny'].includes(decisionRequest.action)) {
      throw new LatticeError('INVALID_ACTION', 'Action must be either "approve" or "deny"', 400);
    }

    // Get the permission request to validate it exists and is pending
    const permissions = permissionTracker.getPermissionRequests({ status: 'pending' });
    const permission = permissions.find(p => p.id === requestId);

    if (!permission) {
      throw new LatticeError('PERMISSION_NOT_FOUND', 'Permission request not found or not pending', 404);
    }

    // Update permission status
    let updated: boolean;
    if (decisionRequest.action === 'approve') {
      updated = permissionTracker.updatePermissionStatus(
        requestId,
        'approved',
        { modifiedInput: decisionRequest.modifiedInput }
      );
    } else {
      updated = permissionTracker.updatePermissionStatus(
        requestId,
        'denied',
        { denyReason: decisionRequest.denyReason }
      );
    }

    if (!updated) {
      throw new LatticeError('UPDATE_FAILED', 'Failed to update permission status', 500);
    }

    // Log structured event
    permissionLog.decision({
      permissionRequestId: requestId,
      toolName: permission.toolName,
      decision: decisionRequest.action,
      denyReason: decisionRequest.denyReason,
      streamingId: permission.streamingId,
    });

    const durationMs = Date.now() - startTime;
    logger.info('Permission decision processed', {
      permissionRequestId: requestId.slice(0, 8),
      action: decisionRequest.action,
      toolName: permission.toolName,
      streamingId: permission.streamingId?.slice(0, 8),
      durationMs,
    });

    const response: PermissionDecisionResponse = {
      success: true,
      message: `Permission ${decisionRequest.action === 'approve' ? 'approved' : 'denied'} successfully`
    };

    res.json(response);
  }));

  return router;
}
