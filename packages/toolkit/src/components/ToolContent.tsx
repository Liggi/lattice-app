import React from 'react';
import { FileText, Edit, Terminal, Search, List, FileEdit, Loader2, Globe, ExternalLink } from 'lucide-react';
import { formatFilePath } from '../utils/tool-utils.js';
import { cn } from '../utils/cn.js';
import { tk, accent } from '../tokens.js';
import type { ChatMessage, ToolResult, CustomToolRenderer, BackgroundTaskOutput, BackgroundTaskState } from '../types.js';
import { ReadTool } from './tools/ReadTool.js';
import { EditTool } from './tools/EditTool.js';
import { WriteTool } from './tools/WriteTool.js';
import { BashTool } from './tools/BashTool.js';
import { SearchTool } from './tools/SearchTool.js';
import { TodoTool } from './tools/TodoTool.js';
import { WebTool } from './tools/WebTool.js';
import { TaskTool } from './tools/TaskTool.js';
import { TaskOutputTool } from './tools/TaskOutputTool.js';
import { PlanTool } from './tools/PlanTool.js';
import { AskUserQuestionTool } from './tools/AskUserQuestionTool.js';
import { DecisionCard } from './DecisionCard.js';
import type { QuestionDefinition } from '../types.js';
import { FallbackTool } from './tools/FallbackTool.js';
import { ChromeDevToolsTool } from './tools/ChromeDevToolsTool.js';
import { MonitorTool } from './tools/MonitorTool.js';
import { ScheduleWakeupTool } from './tools/ScheduleWakeupTool.js';
import { PatchTool, summarizePatchTargets, type PatchToolInput } from './tools/PatchTool.js';
import { renderMcpTool, isMcpTool, isChromeDevToolsTool, mcpToolLabel } from './tools/mcp/index.js';
import { TaskManagementTool } from './tools/TaskManagementTool.js';
import { ToolSearchTool } from './tools/ToolSearchTool.js';
import { SkillTool } from './tools/SkillTool.js';
import { ToolError } from './ToolError.js';
import { TeamCreateTool, SendMessageTool, TeamDeleteTool } from './tools/TeamTools.js';

// ---- Main ToolContent ----

export interface ToolContentProps {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult?: ToolResult;
  workingDirectory?: string;
  toolUseId?: string;
  childrenMessages?: Record<string, ChatMessage[]>;
  toolResults?: Record<string, ToolResult>;
  questionId?: string;
  onAnswerQuestion?: (questionId: string, answers: Record<string, string>) => void;
  isStreaming?: boolean;
  renderChildMessage?: (message: ChatMessage) => React.ReactNode;
  /** Extension point: consumer-defined renderers checked before defaults. */
  customRenderers?: Record<string, CustomToolRenderer>;
  /** Callbacks for PlanTool approval UI. */
  onPlanApprove?: () => void | Promise<void>;
  onPlanReject?: () => void | Promise<void>;
  /** Lookup for historical plan outcome by tool_use_id. */
  planOutcomes?: Record<string, 'approved' | 'rejected'>;
  /** Optional fetcher for BashTool background output. */
  fetchBackgroundOutput?: (path: string) => Promise<BackgroundTaskOutput | null>;
  /** Background command states keyed by the tool_use_id that started each one. */
  backgroundTaskStates?: Record<string, BackgroundTaskState>;
}

export function ToolContent({
  toolName, toolInput, toolResult, workingDirectory, toolUseId,
  childrenMessages, toolResults, questionId, onAnswerQuestion, isStreaming,
  renderChildMessage, customRenderers, onPlanApprove, onPlanReject, planOutcomes,
  fetchBackgroundOutput, backgroundTaskStates,
}: ToolContentProps): React.JSX.Element | null {
  const getResultContent = (): string => {
    if (!toolResult?.result) return '';
    if (typeof toolResult.result === 'string') return toolResult.result;
    if (Array.isArray(toolResult.result)) {
      return toolResult.result.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
    }
    return '';
  };

  const resultContent = getResultContent();
  const isError = toolResult?.is_error === true;
  const isPending = (!toolResult || toolResult.status === 'pending') && isStreaming !== false;

  // ── Check custom renderers first ──
  if (customRenderers?.[toolName]) {
    const rendered = customRenderers[toolName]({
      toolName, input: toolInput, result: resultContent,
      isError, isPending, toolUseId, workingDirectory, isStreaming,
    });
    if (rendered !== undefined) return rendered as React.JSX.Element | null;
  }

  // ── Pending state ──
  if (isPending) {
    if (toolName === 'Task' || toolName === 'Agent') {
      return <TaskTool input={toolInput} result={resultContent} toolUseId={toolUseId} childrenMessages={childrenMessages} toolResults={toolResults} isPending isStreaming={isStreaming} renderChildMessage={renderChildMessage} />;
    }
    if (toolName === 'TaskOutput') {
      return <TaskOutputTool input={toolInput as { task_id?: string; block?: boolean; timeout?: number }} result={resultContent} isPending />;
    }
    // A question is answerable while its tool call waits, so it renders as the card, not as a running tool.
    if (toolName === 'AskUserQuestion') {
      return questionId ? <AskUserQuestionTool input={toolInput} result="" questionId={questionId} onAnswer={onAnswerQuestion} /> : null;
    }
    if (toolName === 'Bash') {
      return <BashTool input={toolInput} result={resultContent} workingDirectory={workingDirectory} isPending fetchBackgroundOutput={fetchBackgroundOutput} backgroundState={toolUseId ? backgroundTaskStates?.[toolUseId] : undefined} />;
    }
    if (toolName === 'Monitor') {
      return <MonitorTool input={toolInput as { description?: string; command?: string; timeout_ms?: number; persistent?: boolean }} result={resultContent} isPending />;
    }
    if (toolName === 'ScheduleWakeup') {
      return <ScheduleWakeupTool input={toolInput as { delaySeconds?: number; prompt?: string; reason?: string }} result={resultContent} isPending />;
    }
    if (toolName === 'Skill') return <SkillTool input={toolInput} isPending />;

    // Generic loading card
    const getToolConfig = () => {
      switch (toolName) {
        case 'Read': return { icon: FileText, label: 'Reading', detail: formatFilePath(String(toolInput?.file_path ?? ''), workingDirectory), iconClass: accent.blue.icon };
        case 'Edit': case 'MultiEdit': return { icon: Edit, label: 'Editing', detail: formatFilePath(String(toolInput?.file_path ?? ''), workingDirectory), iconClass: accent.emerald.icon };
        case 'Write': return { icon: FileEdit, label: 'Writing', detail: formatFilePath(String(toolInput?.file_path ?? ''), workingDirectory), iconClass: accent.violet.icon };
        case 'Bash': return { icon: Terminal, label: 'Running', detail: typeof toolInput?.command === 'string' ? toolInput.command.slice(0, 60) : '', iconClass: accent.orange.icon };
        case 'Grep': return { icon: Search, label: 'Searching', detail: String(toolInput?.pattern ?? ''), iconClass: accent.amber.icon };
        case 'Glob': return { icon: Search, label: 'Finding', detail: String(toolInput?.pattern ?? ''), iconClass: accent.violet.icon };
        case 'LS': return { icon: List, label: 'Listing', detail: String(toolInput?.path ?? '.'), iconClass: accent.violet.icon };
        case 'ToolSearch': return { icon: Search, label: 'Loading tools', detail: String(toolInput?.query ?? ''), iconClass: accent.violet.icon };
        case 'WebSearch': return { icon: Globe, label: 'Searching', detail: String(toolInput?.query ?? ''), iconClass: accent.emerald.icon };
        case 'WebFetch': return { icon: ExternalLink, label: 'Fetching', detail: toolInput?.url ? (() => { try { return new URL(toolInput.url as string).hostname; } catch { return ''; } })() : '', iconClass: accent.emerald.icon };
        case 'ApplyPatch': return { icon: FileEdit, label: 'Patching', detail: summarizePatchTargets(toolInput as PatchToolInput, workingDirectory), iconClass: accent.emerald.icon };
        default: {
          if (isMcpTool(toolName)) {
            const isChromeDevTools = isChromeDevToolsTool(toolName);
            const detail = (toolInput?.selector || toolInput?.url || toolInput?.uid || toolInput?.text || toolInput?.path || toolInput?.query || toolInput?.pattern || '') as string;
            return { icon: isChromeDevTools ? Globe : FileText, label: mcpToolLabel(toolName), detail, iconClass: isChromeDevTools ? accent.cyan.icon : accent.purple.icon };
          }
          return { icon: FileText, label: toolName, detail: '', iconClass: tk.text.muted };
        }
      }
    };

    const config = getToolConfig();
    const IconComponent = config.icon;

    return (
      <div className="w-fit max-w-full">
        <div className={cn('border rounded-lg overflow-hidden', tk.card.border, tk.card.bg)}>
          <div className="flex items-center gap-2 px-3 py-2">
            <Loader2 size={12} className={`${tk.text.muted} flex-shrink-0 animate-spin`} />
            <IconComponent size={14} className={`${config.iconClass} flex-shrink-0`} />
            <span className={`text-xs ${tk.text.muted}`}>{config.label}</span>
            <span className={`text-xs ${tk.text.secondary} truncate flex-1`}>{config.detail}</span>
          </div>
        </div>
      </div>
    );
  }

  // ── Error handling ──
  // A question that expired or was dismissed stays in the thread as a closed card, so it does not vanish unexplained.
  if (isError && toolName === 'AskUserQuestion') {
    return <DecisionCard questions={(toolInput as { questions?: QuestionDefinition[] }).questions ?? []} closed="No longer waiting for an answer" />;
  }
  if (isError && (toolName === 'EnterPlanMode' || resultContent?.toLowerCase().includes('answer questions?'))) {
    return null;
  }

  if (isError && (toolName === 'ExitPlanMode' || toolName === 'exit_plan_mode' || resultContent?.toLowerCase().includes('exit plan mode'))) {
    return <PlanTool input={toolInput} result={resultContent} isPendingApproval priorOutcome={toolUseId && planOutcomes?.[toolUseId] || false} onApprove={onPlanApprove} onReject={onPlanReject} />;
  }

  if (isError) {
    return <ToolError toolName={toolName} toolInput={toolInput} message={resultContent || 'Tool execution failed'} workingDirectory={workingDirectory} />;
  }

  // ── Route to tool component ──
  switch (toolName) {
    case 'Read': return <ReadTool input={toolInput} result={resultContent} workingDirectory={workingDirectory} />;
    case 'Edit': case 'MultiEdit': return <EditTool input={toolInput} result={resultContent} isMultiEdit={toolName === 'MultiEdit'} workingDirectory={workingDirectory} />;
    case 'Write': return <WriteTool input={toolInput} result={resultContent} workingDirectory={workingDirectory} />;
    case 'Bash': return <BashTool input={toolInput} result={resultContent} fetchBackgroundOutput={fetchBackgroundOutput} backgroundState={toolUseId ? backgroundTaskStates?.[toolUseId] : undefined} />;
    case 'Monitor': return <MonitorTool input={toolInput as { description?: string; command?: string; timeout_ms?: number; persistent?: boolean }} result={resultContent} />;
    case 'ScheduleWakeup': return <ScheduleWakeupTool input={toolInput as { delaySeconds?: number; prompt?: string; reason?: string }} result={resultContent} />;
    case 'Grep': case 'Glob': case 'LS': return <SearchTool input={toolInput} result={resultContent} toolType={toolName} />;
    case 'TodoRead': case 'TodoWrite': return <TodoTool input={toolInput} result={resultContent} isWrite={toolName === 'TodoWrite'} />;
    case 'WebSearch': case 'WebFetch': return <WebTool input={toolInput} result={resultContent} toolType={toolName} />;
    case 'Skill': return <SkillTool input={toolInput} />;
    case 'ToolSearch': return <ToolSearchTool input={toolInput as { query?: string; max_results?: number }} result={resultContent} />;
    case 'Task': case 'Agent': return <TaskTool input={toolInput} result={resultContent} toolUseId={toolUseId} childrenMessages={childrenMessages} toolResults={toolResults} isStreaming={isStreaming} renderChildMessage={renderChildMessage} />;
    case 'TaskOutput': return <TaskOutputTool input={toolInput as { task_id?: string; block?: boolean; timeout?: number }} result={resultContent} />;
    case 'TaskCreate': case 'TaskUpdate': return <TaskManagementTool input={toolInput} result={resultContent} isUpdate={toolName === 'TaskUpdate'} />;
    case 'EnterPlanMode': return null;
    case 'exit_plan_mode': case 'ExitPlanMode': return <PlanTool input={toolInput} result={resultContent} onApprove={onPlanApprove} onReject={onPlanReject} />;
    case 'AskUserQuestion': return <AskUserQuestionTool input={toolInput} result={resultContent} questionId={questionId} onAnswer={onAnswerQuestion} />;
    case 'TeamCreate': return <TeamCreateTool input={toolInput as { team_name?: string; description?: string }} result={resultContent} isPending={isPending} isStreaming={isStreaming} />;
    case 'SendMessage': return <SendMessageTool input={toolInput as { type?: 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response' | 'plan_approval_response'; recipient?: string; content?: string; summary?: string; approve?: boolean }} result={resultContent} isPending={isPending} isStreaming={isStreaming} />;
    case 'TeamDelete': return <TeamDeleteTool result={resultContent} isPending={isPending} isStreaming={isStreaming} />;
    case 'ApplyPatch': return <PatchTool input={toolInput as PatchToolInput} result={resultContent} workingDirectory={workingDirectory} />;
    default:
      if (isMcpTool(toolName)) {
        if (isChromeDevToolsTool(toolName)) return <ChromeDevToolsTool toolName={toolName} input={toolInput} result={resultContent} />;
        return renderMcpTool({ toolName, input: toolInput, result: resultContent });
      }
      return <FallbackTool toolName={toolName} input={toolInput} result={resultContent} />;
  }
}
