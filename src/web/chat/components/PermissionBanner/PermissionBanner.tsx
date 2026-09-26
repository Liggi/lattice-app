/* oxlint-disable react-doctor/no-cascading-set-state, react-doctor/no-giant-component, react-doctor/prefer-useReducer, react-doctor/no-render-in-render, react-doctor/no-effect-event-handler */
import React, { useState, useEffect, useMemo } from 'react';
import { ShieldAlert, ClipboardCheck, Check, X, ChevronDown, ChevronRight, FolderLock } from 'lucide-react';
import type { PermissionRequest } from '../../types';
import { api } from '../../services/api';

/**
 * PermissionBanner - Header-style expandable permission prompt
 *
 * Displays pending permission requests in a compact banner format.
 * Supports granular pattern-based permissions via inline expansion.
 *
 * UI combines:
 * - "Allow Always" terminology
 * - Scope toggle (Session / Always)
 * - Pattern list with human-readable descriptions
 */

interface PermissionBannerProps {
  permission: PermissionRequest;
  streamingId?: string;
  workingDirectory?: string;
  onApprove: () => void;
  onApprovePattern: (pattern: string, scope: 'session' | 'global') => void;
  onApprovePatterns: (patterns: string[], scope: 'session' | 'global') => void;
  onDeny: (reason?: string) => void;
  isLoading?: boolean;
}

function normalizeWorkingDirectory(workingDirectory?: string): string | null {
  if (!workingDirectory) return null;
  const trimmed = workingDirectory.trim();
  if (!trimmed || trimmed === '~') return null;
  return trimmed.replace(/\/+$/, '') || null;
}

function buildProjectTrustPatterns(workingDirectory?: string): string[] {
  const normalizedWorkingDirectory = normalizeWorkingDirectory(workingDirectory);
  if (!normalizedWorkingDirectory) return [];
  const recursivePattern = `${normalizedWorkingDirectory}/**`;
  return [
    `Read(${recursivePattern})`,
    `Write(${recursivePattern})`,
    `Edit(${recursivePattern})`,
  ];
}

// Render full tool input for expanded view
function ExpandedToolInput({ toolName, toolInput }: { toolName: string; toolInput: Record<string, unknown> }): JSX.Element {
  switch (toolName) {
    case 'Bash':
      return (
        <div className="space-y-2">
          {!!toolInput.description && (
            <div className="text-xs text-fg-2">{toolInput.description as string}</div>
          )}
          <pre className="font-mono text-[13px] text-fg whitespace-pre-wrap break-all bg-bg border border-line rounded-md p-3">
            {toolInput.command as string}
          </pre>
        </div>
      );
    case 'Read':
    case 'Write':
      return (
        <div className="space-y-2">
          <div className="font-mono text-[13px] text-fg">{toolInput.file_path as string}</div>
          {!!toolInput.content && (
            <pre className="font-mono text-xs text-fg-2 whitespace-pre-wrap break-all bg-bg border border-line rounded-md p-3 max-h-64 overflow-auto">
              {(toolInput.content as string).slice(0, 2000)}
              {(toolInput.content as string).length > 2000 && '...'}
            </pre>
          )}
        </div>
      );
    case 'Edit':
      return (
        <div className="space-y-2">
          <div className="font-mono text-[13px] text-fg">{toolInput.file_path as string}</div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-xs text-rose-300 mb-1">Old</div>
              <pre className="font-mono text-xs text-fg-2 whitespace-pre-wrap break-all bg-[rgb(var(--color-rose-rgb)/0.08)] rounded-md p-2 max-h-32 overflow-auto">
                {toolInput.old_string as string}
              </pre>
            </div>
            <div>
              <div className="text-xs text-emerald-400 mb-1">New</div>
              <pre className="font-mono text-xs text-fg-2 whitespace-pre-wrap break-all bg-[rgb(var(--color-emerald-rgb)/0.08)] rounded-md p-2 max-h-32 overflow-auto">
                {toolInput.new_string as string}
              </pre>
            </div>
          </div>
        </div>
      );
    default:
      return (
        <pre className="font-mono text-xs text-fg-2 whitespace-pre-wrap break-all bg-bg border border-line rounded-md p-3 max-h-64 overflow-auto">
          {JSON.stringify(toolInput, null, 2)}
        </pre>
      );
  }
}

// Format tool input for compact display
function formatToolSummary(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return (input.command as string) || '';
    case 'Read':
    case 'Write':
    case 'Edit':
      return (input.file_path as string) || '';
    case 'Grep':
      return `"${String(input.pattern ?? '')}" in ${String(input.path ?? '')}`;
    case 'Glob':
      return (input.pattern as string) || '';
    case 'WebFetch':
      return (input.url as string) || '';
    case 'Task':
      return (input.description as string) || (input.prompt as string)?.slice(0, 50) || '';
    default:
      return JSON.stringify(input).slice(0, 60);
  }
}

// Generate human-readable description for a pattern
function getPatternDescription(pattern: string, totalPatterns: number, index: number): string {
  // First pattern is always exact match
  if (index === 0) {
    return 'Only this exact operation';
  }

  // Last pattern is always the broadest (just the tool name)
  if (index === totalPatterns - 1) {
    const toolMatch = pattern.match(/^([A-Za-z]+)$/);
    if (toolMatch) {
      return `All ${toolMatch[1].toLowerCase()} operations`;
    }
  }

  // Parse pattern to generate description
  const match = pattern.match(/^([A-Za-z]+)\((.+)\)$/);
  if (!match) {
    return pattern;
  }

  const [, tool, innerPattern] = match;

  // Bash patterns
  if (tool === 'Bash') {
    if (innerPattern.endsWith(' *')) {
      const prefix = innerPattern.slice(0, -2);
      return `Any "${prefix}" command`;
    }
    return `Commands matching "${innerPattern}"`;
  }

  // File-based patterns (Write, Read, Edit)
  if (['Write', 'Read', 'Edit'].includes(tool)) {
    if (innerPattern.startsWith('*.')) {
      return `Any ${innerPattern.slice(1)} file`;
    }
    if (innerPattern.includes('**')) {
      const parts = innerPattern.split('**');
      if (parts[0] && parts[1]) {
        return `Any ${parts[1].replace(/^\/?\*?/, '')} file under ${parts[0].replace(/\/$/, '')}`;
      }
      return `Any file under ${innerPattern.replace('/**', '')}`;
    }
    if (innerPattern.includes('*')) {
      const dir = innerPattern.substring(0, innerPattern.lastIndexOf('/'));
      const ext = innerPattern.includes('.') ? innerPattern.split('.').pop() : null;
      if (ext) {
        return `Any .${ext} file in ${dir || 'this directory'}`;
      }
      return `Any file in ${dir || 'this directory'}`;
    }
    return `File: ${innerPattern}`;
  }

  return pattern;
}

/**
 * PlanApprovalBanner - Distinct UI for ExitPlanMode permission requests.
 *
 * When Claude proposes a plan and calls ExitPlanMode, the generic amber
 * permission banner is confusing — it looks identical to a Bash permission
 * prompt. This component renders a distinct plan approval card instead,
 * making it clear the user is approving an implementation plan.
 */
function PlanApprovalBanner({
  onApprove,
  onDeny,
  isLoading,
}: {
  onApprove: () => void;
  onDeny: (reason?: string) => void;
  isLoading?: boolean;
}): JSX.Element {
  return (
    <div data-testid="plan-approval-banner" className="border border-line rounded-lg overflow-hidden bg-surface">
      <div className="px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <ClipboardCheck size={16} className="text-accent shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-fg">
                Implement plan
              </span>
              <span className="text-fg-3 shrink-0">·</span>
              <span className="text-sm text-fg-2">
                Claude is ready to implement the plan above
              </span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0 sm:justify-end">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDeny('Plan rejected — please revise or take a different approach.');
            }}
            disabled={isLoading}
            className="group flex min-h-9 items-center gap-1.5 px-3 py-1.5 text-xs font-medium ui-action-btn disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <X size={12} />
            Reject
          </button>
          <button
            data-testid="plan-approve-button"
            onClick={(e) => {
              e.stopPropagation();
              onApprove();
            }}
            disabled={isLoading}
            className="group flex min-h-9 items-center gap-1.5 px-3 py-1.5 text-xs font-medium ui-action-btn disabled:opacity-50 disabled:cursor-not-allowed ui-action-btn--accent"
          >
            <Check size={12} />
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}

export function PermissionBanner({
  permission,
  streamingId: _streamingId,
  workingDirectory,
  onApprove,
  onApprovePattern,
  onApprovePatterns,
  onDeny,
  isLoading,
}: PermissionBannerProps): JSX.Element {
  // ExitPlanMode gets a distinct plan approval UI instead of the generic permission banner.
  // This prevents users from confusing plan approval with a generic tool permission prompt.
  const isPlanApproval = permission.toolName === 'ExitPlanMode' || permission.toolName === 'exit_plan_mode';

  const [isExpanded, setIsExpanded] = useState(false);
  const [showAlwaysPanel, setShowAlwaysPanel] = useState(false);
  const [suggestedPatterns, setSuggestedPatterns] = useState<string[]>([]);
  const [patternsLoading, setPatternsLoading] = useState(false);

  const summary = formatToolSummary(permission.toolName, permission.toolInput);
  const normalizedWorkingDirectory = useMemo(
    () => normalizeWorkingDirectory(workingDirectory),
    [workingDirectory]
  );
  const projectTrustPatterns = useMemo(
    () => buildProjectTrustPatterns(workingDirectory),
    [workingDirectory]
  );
  const projectLabel = normalizedWorkingDirectory?.split('/').filter(Boolean).pop() || 'project';

  // Start fetching patterns IMMEDIATELY when permission arrives
  // This way, by the time user clicks "Allow Always", suggestions are ready
  useEffect(() => {
    // Skip pattern fetching for plan approval — no "Allow Always" needed
    if (isPlanApproval) return;

    // Only fetch once per permission
    if (suggestedPatterns.length > 0 || patternsLoading) {
      return;
    }

    setPatternsLoading(true);
    api
      .getSuggestedPatterns(permission.toolName, permission.toolInput)
      .then(({ patterns }) => setSuggestedPatterns(patterns))
      .catch((err) => {
        console.error('Failed to fetch suggested patterns:', err);
        // Fallback to just the tool name
        setSuggestedPatterns([permission.toolName]);
      })
      .finally(() => setPatternsLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Only fetch when permission.id changes; other deps are guards or used in fetch
  }, [permission.id]);

  const handlePatternSelect = (pattern: string) => {
    setShowAlwaysPanel(false);
    onApprovePattern(pattern, 'global');
  };

  const handleProjectTrust = (scope: 'session' | 'global') => {
    if (projectTrustPatterns.length === 0) return;
    setShowAlwaysPanel(false);
    onApprovePatterns(projectTrustPatterns, scope);
  };

  if (isPlanApproval) {
    return <PlanApprovalBanner onApprove={onApprove} onDeny={onDeny} isLoading={isLoading} />;
  }

  return (
    <div data-testid="permission-banner" className="border border-line rounded-lg overflow-hidden bg-[rgb(var(--color-amber-rgb)/0.08)]">
      {/* Header row */}
      <div className="px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-start gap-3 flex-1 min-w-0 text-left"
          disabled={isLoading}
        >
          {isExpanded ? (
            <ChevronDown size={14} className="text-fg-3 shrink-0 mt-0.5" />
          ) : (
            <ChevronRight size={14} className="text-fg-3 shrink-0 mt-0.5" />
          )}
          <ShieldAlert size={16} className="text-amber-400 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <span className="text-sm font-medium text-amber-400 shrink-0">
                {permission.toolName}
              </span>
              <span className="text-fg-3 shrink-0">·</span>
              <span className={`text-[13px] text-fg-2 font-mono ${isExpanded ? 'break-all' : 'line-clamp-2 break-all sm:line-clamp-1'}`}>
                {summary}
              </span>
            </div>
          </div>
        </button>
        <div className="flex flex-wrap items-center gap-2 shrink-0 sm:justify-end">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDeny();
            }}
            disabled={isLoading}
            className="group flex min-h-9 items-center gap-1.5 px-3 py-1.5 text-xs font-medium ui-action-btn disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <X size={12} />
            Deny
          </button>
          <button
            data-testid="permission-allow-button"
            onClick={(e) => {
              e.stopPropagation();
              onApprove();
            }}
            disabled={isLoading}
            className="group flex min-h-9 items-center gap-1.5 px-3 py-1.5 text-xs font-medium ui-action-btn disabled:opacity-50 disabled:cursor-not-allowed ui-action-btn--accent"
          >
            <Check size={12} />
            Allow
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowAlwaysPanel(!showAlwaysPanel);
            }}
            disabled={isLoading}
            className={`group flex min-h-9 items-center gap-1.5 px-3 py-1.5 text-xs font-medium ui-action-btn disabled:opacity-50 disabled:cursor-not-allowed ${showAlwaysPanel ? 'bg-surface-2 text-fg' : ''}`}
          >
            {showAlwaysPanel ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Allow always
          </button>
        </div>
      </div>

      {/* Expanded details - show full tool input */}
      {isExpanded && !showAlwaysPanel && (
        <div className="border-t border-line px-4 py-3 bg-bg">
          <ExpandedToolInput toolName={permission.toolName} toolInput={permission.toolInput} />
        </div>
      )}

      {/* Allow Always panel - inline expansion */}
      {showAlwaysPanel && (
        <div className="border-t border-line bg-bg">
          {projectTrustPatterns.length > 0 && normalizedWorkingDirectory && (
            <div className="px-3 pt-3">
              <div className="rounded-lg border border-line bg-surface overflow-hidden">
                <div className="px-4 py-3 border-b border-line flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <FolderLock size={14} className="text-fg-3 shrink-0" />
                      <span className="text-sm font-medium text-fg">
                        Trust project files
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-fg-2">
                      Allow Claude to read and edit files anywhere under <span className="font-medium text-fg">{projectLabel}</span>.
                    </p>
                    <p className="mt-1 font-mono text-xs text-fg-3 break-all">
                      {normalizedWorkingDirectory}/**
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 shrink-0 sm:justify-end">
                    <button
                      onClick={() => handleProjectTrust('session')}
                      className="min-h-8 px-2.5 py-1.5 text-xs font-medium ui-action-btn"
                    >
                      This session
                    </button>
                    <button
                      onClick={() => handleProjectTrust('global')}
                      className="min-h-8 px-2.5 py-1.5 text-xs font-medium ui-action-btn ui-action-btn--accent"
                    >
                      Always
                    </button>
                  </div>
                </div>
                <div className="px-4 py-2 text-xs text-fg-3 border-t border-line">
                  Adds <span className="font-mono text-fg-2">Read</span>, <span className="font-mono text-fg-2">Write</span>, and <span className="font-mono text-fg-2">Edit</span> allowlist rules for this working directory.
                </div>
              </div>
            </div>
          )}

          {projectTrustPatterns.length > 0 && (
            <div className="px-4 pt-3 text-xs font-medium text-fg-2">
              More specific patterns
            </div>
          )}

          {/* Pattern list */}
          <div className="py-2">
            {patternsLoading ? (
              <div className="px-4 py-4 text-center text-xs text-fg-3">Loading patterns...</div>
            ) : (
              suggestedPatterns.map((pattern, idx) => {
                const description = getPatternDescription(pattern, suggestedPatterns.length, idx);
                const isFirst = idx === 0;
                const isLast = idx === suggestedPatterns.length - 1 && suggestedPatterns.length > 1;

                return (
                  <button
                    key={pattern}
                    onClick={() => handlePatternSelect(pattern)}
                    className="w-full text-left px-4 py-2.5 hover:bg-surface transition-colors flex items-center gap-3 group"
                  >
                    {/* Level indicator dot */}
                    <div
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        isFirst
                          ? 'bg-emerald-400'
                          : isLast
                            ? 'bg-amber-400'
                            : 'bg-fg-3/40'
                      }`}
                    />

                    {/* Pattern and description */}
                    <div className="flex-1 min-w-0">
                      <span className="font-mono text-xs text-fg">
                        {pattern}
                      </span>
                      <span className="text-xs text-fg-2 block mt-0.5">
                        {description}
                      </span>
                    </div>

                    {/* Badges */}
                    {isFirst && (
                      <span className="text-xs text-emerald-400 bg-[rgb(var(--color-emerald-rgb)/0.1)] px-1.5 py-0.5 rounded-sm shrink-0">
                        Safest
                      </span>
                    )}
                    {isLast && (
                      <span className="text-xs text-amber-400 bg-[rgb(var(--color-amber-rgb)/0.1)] px-1.5 py-0.5 rounded-sm shrink-0">
                        Broad
                      </span>
                    )}

                    {/* Hover checkmark */}
                    <Check
                      size={14}
                      className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-accent"
                    />
                  </button>
                );
              })
            )}
          </div>

          {/* Footer hint */}
          <div className="px-4 py-2 border-t border-line text-xs text-fg-3">
            <span>Patterns added here are saved globally. Use "This session" above for repo trust without persisting it.</span>
          </div>
        </div>
      )}
    </div>
  );
}
