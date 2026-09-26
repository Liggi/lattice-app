import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Bot, Loader2, Compass, LayoutDashboard, Eye, Cpu, Wrench, type LucideIcon } from 'lucide-react';
import type { ChatMessage, ToolResult } from '../../types.js';
import { CollapsibleToolCard } from '../CollapsibleToolCard.js';
import { useAgentColor } from '../../context.js';
import { cn } from '../../utils/cn.js';
import { tk, TINTS, DEFAULT_TINT } from '../../tokens.js';

/** Visual identity for a subagent type — icon, tint, and display label. */
interface SubagentVisual {
  icon: LucideIcon;
  tint: typeof DEFAULT_TINT;
  label: string;
}

/** Maps known Claude Code subagent types to distinct visual identities. */
const SUBAGENT_VISUALS: Record<string, SubagentVisual> = {
  'Explore': {
    icon: Compass,
    tint: TINTS.blue,
    label: 'Explorer',
  },
  'Plan': {
    icon: LayoutDashboard,
    tint: TINTS.yellow,
    label: 'Architect',
  },
  'code-reviewer': {
    icon: Eye,
    tint: TINTS.purple,
    label: 'Reviewer',
  },
  'statusline-setup': {
    icon: Wrench,
    tint: TINTS.green,
    label: 'Config',
  },
};

const DEFAULT_VISUAL: SubagentVisual = {
  icon: Cpu,
  tint: TINTS.purple,
  label: 'Agent',
};

interface TaskToolProps {
  input: { prompt?: string; description?: string; subagent_type?: string; team_name?: string; name?: string };
  result: string;
  toolUseId?: string;
  childrenMessages?: Record<string, ChatMessage[]>;
  toolResults?: Record<string, ToolResult>;
  isPending?: boolean;
  isStreaming?: boolean;
  renderChildMessage?: (message: ChatMessage) => React.ReactNode;
}

const EMPTY_CHILDREN: Record<string, ChatMessage[]> = {};

export function TaskTool({
  input, result, toolUseId, childrenMessages = EMPTY_CHILDREN,
  isPending = false, isStreaming, renderChildMessage,
}: TaskToolProps): React.JSX.Element {
  const hasChildren = toolUseId && childrenMessages[toolUseId] && childrenMessages[toolUseId].length > 0;
  const children = toolUseId ? childrenMessages[toolUseId] || [] : [];

  const taskDescription = input?.description || 'Subagent task';
  const agentType = input?.subagent_type || 'general';
  const isTeamTask = !!input?.team_name;
  const agentName = input?.name;

  // Resolve visual identity: team color overrides subagent type tint
  const teamColor = useAgentColor(input?.name);
  const subagentVisual = SUBAGENT_VISUALS[agentType] || DEFAULT_VISUAL;
  const tint = (teamColor && TINTS[teamColor]) || subagentVisual.tint;
  const AgentIcon = isTeamTask ? Bot : subagentVisual.icon;
  const displayLabel = isTeamTask ? (agentName || 'Agent') : subagentVisual.label;

  const isRunning = isStreaming !== false && (isPending || (!result && !hasChildren));

  const resultLines = result ? result.split('\n').filter(l => l.trim()).length : 0;
  const [isExpanded, setIsExpanded] = useState(() => hasChildren || (resultLines > 0 && resultLines <= 5));

  useEffect(() => {
    if (hasChildren && !isExpanded) setIsExpanded(true);
  }, [hasChildren]);

  // Auto-scroll children area when new messages arrive, but only if the user
  // hasn't scrolled up to read earlier content.
  const childrenRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  const handleChildrenScroll = useCallback(() => {
    const el = childrenRef.current;
    if (!el) return;
    // "Near bottom" = within 60px of the scroll floor
    userScrolledUpRef.current = el.scrollHeight - el.scrollTop - el.clientHeight > 60;
  }, []);

  useEffect(() => {
    if (childrenRef.current && children.length > 0 && !userScrolledUpRef.current) {
      childrenRef.current.scrollTo({
        top: childrenRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [children.length]);

  return (
    <CollapsibleToolCard
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      wrapperClassName="w-full"
      cardClassName={cn(tint.border, tint.bg)}
      headerContent={(
        <>
          <div className="flex items-center gap-2">
            {isRunning ? (
              <Loader2 size={14} className={cn(tint.icon, 'animate-spin flex-shrink-0')} />
            ) : (
              <AgentIcon size={14} className={cn(tint.icon, 'flex-shrink-0')} />
            )}
            <span className={`text-xs font-medium ${tk.text.muted}`}>{displayLabel}</span>
            {isTeamTask && teamColor && (
              <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', isRunning ? 'animate-pulse' : '', `bg-${teamColor}-400`)} />
            )}
          </div>
          <span className={`text-xs ${tk.text.secondary} truncate flex-1`}>{taskDescription}</span>
          {agentType !== 'general' && agentType !== 'general-purpose' && (
            <span className={`text-[13px] ${tk.text.faint}`}>{agentType}</span>
          )}
        </>
      )}
      content={(
        <div className={`border-t ${tk.separator}`}>
          {hasChildren ? (
            <div
              ref={childrenRef}
              onScroll={handleChildrenScroll}
              className={cn('max-h-80 overflow-y-auto p-3 space-y-1', tk.scrollbar, 'bg-stone-50/50 dark:bg-stone-950/50')}
            >
              {children.map((childMessage) => (
                <React.Fragment key={childMessage.messageId}>
                  {renderChildMessage ? renderChildMessage(childMessage) : null}
                </React.Fragment>
              ))}
            </div>
          ) : result ? (
            <pre className={cn('m-0 px-3 py-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words', tk.codeBg, tk.text.primary)}>
              {result}
            </pre>
          ) : null}
        </div>
      )}
    />
  );
}
