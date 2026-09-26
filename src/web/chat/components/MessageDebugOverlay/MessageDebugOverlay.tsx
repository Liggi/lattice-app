/**
 * Message Debug Overlay
 *
 * Dev-mode overlay showing live message pipeline state. Helps diagnose
 * display bugs (duplicate messages, missing tool results, phantom user
 * messages) without needing to dig through console logs.
 *
 * Activation:
 *   - URL: ?debug=messages
 *   - Console: __latticeDebug.enable('messages')
 *
 * See docs/MESSAGE_TESTING_INFRA.md (Phase 6) for the full design.
 */

import React, { useState, useMemo, useCallback } from 'react';
import type { ChatMessage, ToolResult } from '../../types';
import { checkMessageInvariants } from '../../utils/message-invariants';

interface MessageDebugOverlayProps {
  messages: ChatMessage[];
  toolResults: Record<string, ToolResult>;
  childrenMessages: Record<string, ChatMessage[]>;
  sessionId?: string;
}

export const MessageDebugOverlay: React.FC<MessageDebugOverlayProps> = ({
  messages,
  toolResults,
  childrenMessages,
  sessionId,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const stats = useMemo(() => {
    const userMessages = messages.filter(m => m.type === 'user');
    const assistantMessages = messages.filter(m => m.type === 'assistant');
    const systemMessages = messages.filter(m => m.type !== 'user' && m.type !== 'assistant');

    const toolUseCount = messages.reduce((count, msg) => {
      if (msg.type === 'assistant' && Array.isArray(msg.content)) {
        return count + (msg.content as Array<{ type: string }>).filter(b => b.type === 'tool_use').length;
      }
      return count;
    }, 0);

    const completedToolResults = Object.values(toolResults).filter(r => r.status === 'completed').length;
    const pendingToolResults = Object.values(toolResults).filter(r => r.status === 'pending').length;
    const childGroupCount = Object.keys(childrenMessages).length;
    const totalChildMessages = Object.values(childrenMessages).reduce((sum, arr) => sum + arr.length, 0);

    return {
      total: messages.length,
      user: userMessages.length,
      assistant: assistantMessages.length,
      system: systemMessages.length,
      toolUseCount,
      completedToolResults,
      pendingToolResults,
      totalToolResults: Object.keys(toolResults).length,
      childGroupCount,
      totalChildMessages,
    };
  }, [messages, toolResults, childrenMessages]);

  const violations = useMemo(() => {
    return checkMessageInvariants(
      { displayMessages: messages, toolResults, childMessages: childrenMessages },
    );
  }, [messages, toolResults, childrenMessages]);

  const errorViolations = violations.filter(v => v.severity === 'error');
  const warningViolations = violations.filter(v => v.severity === 'warning');

  const handleCopyState = useCallback(() => {
    const state = {
      sessionId,
      stats,
      violations,
      messages: messages.map(m => ({
        id: m.id,
        messageId: m.messageId,
        type: m.type,
        contentType: typeof m.content === 'string' ? 'string' : 'blocks',
        blockTypes: Array.isArray(m.content) ? (m.content as Array<{ type: string }>).map(b => b.type) : [],
        parentToolUseId: m.parentToolUseId,
      })),
      toolResults: Object.entries(toolResults).map(([id, r]) => ({
        id,
        status: r.status,
        hasResult: !!r.result,
        isError: r.is_error,
      })),
      childrenMessages: Object.entries(childrenMessages).map(([parentId, msgs]) => ({
        parentId,
        count: msgs.length,
      })),
    };
    void navigator.clipboard.writeText(JSON.stringify(state, null, 2));
  }, [sessionId, stats, violations, messages, toolResults, childrenMessages]);

  if (isCollapsed) {
    return (
      <button
        onClick={() => setIsCollapsed(false)}
        className="fixed bottom-4 right-4 z-50 px-3 py-1.5 text-xs
          bg-surface border border-line text-fg-2 rounded-md
          hover:bg-surface-2 hover:text-fg transition-colors"
        title="Show message debug overlay"
      >
        Msgs {errorViolations.length > 0 ? `!! ${errorViolations.length}` : `${stats.total}`}
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 text-xs
      bg-surface border border-line rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2
        border-b border-line">
        <span className="text-xs font-medium text-fg-2">
          Message pipeline
        </span>
        <div className="flex gap-1.5">
          <button
            onClick={handleCopyState}
            className="ui-action-btn px-1.5 py-0.5"
            title="Copy state to clipboard"
          >
            Copy
          </button>
          <button
            onClick={() => setIsCollapsed(true)}
            className="ui-action-btn px-1.5 py-0.5"
          >
            —
          </button>
        </div>
      </div>

      {/* Session info */}
      {sessionId && (
        <div className="px-3 py-1.5 border-b border-line font-mono text-fg-3">
          {sessionId.slice(0, 20)}{sessionId.length > 20 ? '…' : ''}
        </div>
      )}

      {/* Stats */}
      <div className="px-3 py-2 space-y-1">
        <div className="flex justify-between">
          <span className="text-fg-2">Display msgs:</span>
          <span className="text-fg tabular-nums">{stats.total}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-fg-2">User / Asst:</span>
          <span className="text-fg tabular-nums">
            {stats.user} / {stats.assistant}
            {stats.system > 0 && <span className="text-fg-3"> + {stats.system} other</span>}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-fg-2">Tool results:</span>
          <span className={`tabular-nums ${stats.pendingToolResults > 0 ? 'text-amber-400' : 'text-fg'}`}>
            {stats.completedToolResults}/{stats.totalToolResults}
            {stats.pendingToolResults > 0 && ` (${stats.pendingToolResults} pending)`}
          </span>
        </div>
        {stats.childGroupCount > 0 && (
          <div className="flex justify-between">
            <span className="text-fg-2">Children:</span>
            <span className="text-fg tabular-nums">
              {stats.totalChildMessages} in {stats.childGroupCount} groups
            </span>
          </div>
        )}
      </div>

      {/* Invariants */}
      <div className="px-3 py-2 border-t border-line">
        {errorViolations.length === 0 && warningViolations.length === 0 ? (
          <div className="text-emerald-400">✓ No violations</div>
        ) : (
          <div className="space-y-1">
            {errorViolations.length > 0 && (
              <div className="text-rose-300">
                ✗ {errorViolations.length} error{errorViolations.length !== 1 ? 's' : ''}
              </div>
            )}
            {warningViolations.length > 0 && (
              <div className="text-amber-400">
                ⚠ {warningViolations.length} warning{warningViolations.length !== 1 ? 's' : ''}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Expandable details */}
      {violations.length > 0 && (
        <div className="border-t border-line">
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="w-full px-3 py-1.5 text-left text-fg-2
              hover:text-fg hover:bg-surface-2 transition-colors"
          >
            {showDetails ? '▼' : '▶'} Details
          </button>
          {showDetails && (
            <div className="px-3 pb-2 space-y-1.5 max-h-40 overflow-y-auto">
              {violations.map((v, i) => (
                <div
                  key={i}
                  className={`text-xs leading-tight ${
                    v.severity === 'error' ? 'text-rose-300' : 'text-amber-400'
                  }`}
                >
                  <span className="font-mono">[{v.rule}]</span> {v.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
