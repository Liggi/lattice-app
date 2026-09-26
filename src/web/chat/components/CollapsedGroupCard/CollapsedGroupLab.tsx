import React, { useState, useMemo } from 'react';
import { ArrowLeft, Pencil, FileText, Terminal, ChevronDown } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/web/chat/lib/utils';
import { CollapsedToolGroup, type CollapsedGroupData } from '@liggi/agent-ui-toolkit';
import { diffLines as computeDiff } from 'diff';

// ============================================================
// A sample agent turn: an edit to this repo's ConversationView.
// Fixture data only. No session is read or written by this page.
// ============================================================

const GROUP_CV_READS: CollapsedGroupData = {
  id: 'group-cv-reads',
  summary: 'Read 3 files',
  timestamp: new Date().toISOString(),
  toolCalls: [
    { tool: 'read', input: 'ConversationView.tsx :130-198', filePath: 'ConversationView.tsx', status: 'success',
      resultContent: `    messages: harnessMessages,\n    send: harnessSend,\n    stop: harnessStopFn,\n    reconnect: harnessReconnect,\n    injectEvent: _harnessInjectEvent,\n  } = useHarnessSession(conversationId ?? null);` },
    { tool: 'read', input: 'ConversationView.tsx :198-318', filePath: 'ConversationView.tsx', status: 'success',
      resultContent: `  const mergedMessages = useMemo(() => {\n    if (harnessMessages.length === 0) {\n      return optimisticUserMessage\n        ? [...historicalMessages, optimisticUserMessage]\n        : historicalMessages;\n    }` },
    { tool: 'read', input: 'ConversationView.tsx :318-585', filePath: 'ConversationView.tsx', status: 'success',
      resultContent: `  }, [conversationId, harnessConnected, harnessSend, harnessReconnect]);` },
  ],
};

const GROUP_GREP_READS: CollapsedGroupData = {
  id: 'group-grep-reads',
  summary: 'Read 2 files, searched 1 pattern',
  timestamp: new Date().toISOString(),
  toolCalls: [
    { tool: 'grep', input: 'conversationDetails|useQuery.*conversation|hydrateSession', status: 'success',
      resultContent: `61:  hydrateSessionMessagesFromConversationDetails,\n587:  const conversationDetailsLimit = useMemo(` },
    { tool: 'read', input: 'ConversationView.tsx :585-720', filePath: 'ConversationView.tsx', status: 'success',
      resultContent: `  const conversationDetailsLimit = useMemo(\n    () => resolveConversationDetailsLimit(INITIAL_MESSAGE_LIMIT, hydrationComparableMessageCount),\n    [hydrationComparableMessageCount]\n  );` },
    { tool: 'read', input: 'ConversationView.tsx :720-820', filePath: 'ConversationView.tsx', status: 'success',
      resultContent: `  useEffect(() => {\n    if (!conversationDetails) return;\n    hydrateSessionMessagesFromConversationDetails({\n      conversationDetails,\n      setSessionMessages: setHarnessMessages,\n    });` },
  ],
};

// The turn's edits
const EDITS = {
  addFetchToDestructure: {
    path: 'ConversationView.tsx',
    old: `    messages: harnessMessages,
    send: harnessSend,
    stop: harnessStopFn,
    reconnect: harnessReconnect,
    injectEvent: _harnessInjectEvent,
  } = useHarnessSession(conversationId ?? null);`,
    new: `    messages: harnessMessages,
    send: harnessSend,
    stop: harnessStopFn,
    reconnect: harnessReconnect,
    injectEvent: _harnessInjectEvent,
    fetchHistory: harnessFetchHistory,
  } = useHarnessSession(conversationId ?? null);`,
  },
  removeDeadState: {
    path: 'ConversationView.tsx',
    old: `  const [harnessQueuedMessages, setHarnessQueuedMessages] = useState<QueuedUserMessage[]>([]);
  const [harnessSessionStartTime, setHarnessSessionStartTime] = useState<number | null>(null);
  const [historicalMessages, setHistoricalMessages] = useState<ChatMessage[]>([]);
  const [optimisticUserMessage, setOptimisticUserMessage] = useState<ChatMessage | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);`,
    new: `  const [harnessQueuedMessages, setHarnessQueuedMessages] = useState<QueuedUserMessage[]>([]);
  const [harnessSessionStartTime, setHarnessSessionStartTime] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);`,
  },
  removeOptimisticEffect: {
    path: 'ConversationView.tsx',
    old: `  // Clear optimistic user message once the real one arrives via SSE.
  useEffect(() => {
    if (!optimisticUserMessage) return;
    const realArrived = harnessMessages.some(
      m => m.type === 'user' && typeof m.content === 'string' && m.content === optimisticUserMessage.content,
    );
    if (realArrived) setOptimisticUserMessage(null);
  }, [harnessMessages, optimisticUserMessage]);

  // Merge historical + live harness messages.`,
    new: `  // Messages come directly from the harness — single pipeline, no merge.`,
  },
  replaceMergePipeline: {
    path: 'ConversationView.tsx',
    old: `  const mergedMessages = useMemo(() => {
    if (harnessMessages.length === 0) {
      return optimisticUserMessage
        ? [...historicalMessages, optimisticUserMessage]
        : historicalMessages;
    }
    if (historicalMessages.length === 0) {
      return optimisticUserMessage
        ? [optimisticUserMessage, ...harnessMessages]
        : harnessMessages;
    }
    // Timestamp-proximity dedup...
    const DEDUP_WINDOW_MS = 500;
    const historicalBuckets = new Set<number>();
    for (const msg of historicalMessages) {
      const ts = new Date(msg.timestamp).getTime();
      const bucket = Math.floor(ts / DEDUP_WINDOW_MS);
      historicalBuckets.add(bucket);
      historicalBuckets.add(bucket + 1);
    }
    const deduped = harnessMessages.filter(m => {
      const ts = new Date(m.timestamp).getTime();
      return !historicalBuckets.has(Math.floor(ts / DEDUP_WINDOW_MS));
    });
    return [...historicalMessages, ...deduped];
  }, [historicalMessages, harnessMessages, optimisticUserMessage]);`,
    new: `  // Single pipeline: harness events are the sole message source.
  // No merge, no dedup, no timestamp comparison.
  const mergedMessages = harnessMessages;`,
  },
};

// ---- Inline diff component ----

function InlineDiff({ oldValue, newValue }: { oldValue: string; newValue: string }): JSX.Element {
  const lines = useMemo(() => {
    const changes = computeDiff(oldValue, newValue);
    const result: Array<{ type: 'added' | 'removed' | 'unchanged'; content: string }> = [];
    for (const change of changes) {
      const changeLines = change.value.split('\n');
      if (changeLines[changeLines.length - 1] === '') changeLines.pop();
      for (const line of changeLines) {
        result.push({
          type: change.added ? 'added' : change.removed ? 'removed' : 'unchanged',
          content: line,
        });
      }
    }
    return result;
  }, [oldValue, newValue]);

  return (
    <div className="font-mono text-[10px] leading-relaxed overflow-x-auto">
      {lines.map((line, i) => (
        <div key={i} className={cn(
          'flex',
          line.type === 'added' && 'bg-[rgb(var(--color-emerald-rgb)/0.1)]',
          line.type === 'removed' && 'bg-[rgb(var(--color-rose-rgb)/0.1)]',
        )}>
          <span className={cn(
            'select-none w-4 text-center shrink-0',
            line.type === 'added' ? 'text-emerald-400' : line.type === 'removed' ? 'text-rose-300' : 'text-fg-3',
          )}>
            {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
          </span>
          <span className="flex-1 whitespace-pre-wrap break-all px-2 text-fg-2">
            {line.content || ' '}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---- Edit card with diff ----

function EditCard({ path, old: oldStr, new: newStr }: { path: string; old: string; new: string }): JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const oldLines = oldStr.split('\n').length;
  const newLines = newStr.split('\n').length;
  const delta = newLines - oldLines;
  const summary = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : '~';

  return (
    <div className="rounded-lg border border-line bg-surface">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left cursor-pointer hover:bg-surface-2 transition-colors"
      >
        <Pencil className="w-3.5 h-3.5 text-fg-3 flex-shrink-0" />
        <span className="text-xs text-fg-3">Edit</span>
        <span className="text-xs text-fg-2 truncate flex-1">{path}</span>
        <span className={cn(
          'text-xs tabular-nums flex-shrink-0',
          delta > 0 ? 'text-emerald-400' : delta < 0 ? 'text-rose-300' : 'text-fg-3',
        )}>{summary}</span>
        <ChevronDown className={cn(
          'w-3 h-3 text-fg-3 transition-transform duration-150 flex-shrink-0',
          isExpanded && 'rotate-180',
        )} />
      </button>
      {isExpanded && (
        <div className="border-t border-line bg-bg rounded-b-lg overflow-hidden">
          <InlineDiff oldValue={oldStr} newValue={newStr} />
        </div>
      )}
    </div>
  );
}

// ---- Simple tool card ----

function ToolCard({ label, detail, icon: Icon, iconColor }: {
  label: string;
  detail: string;
  icon: typeof Pencil;
  iconColor: string;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon className={cn('w-3.5 h-3.5 flex-shrink-0', iconColor)} />
        <span className="text-xs text-fg-3">{label}</span>
        <span className="text-xs text-fg-2 truncate flex-1">{detail}</span>
      </div>
    </div>
  );
}

// ---- Lab page ----

export function CollapsedGroupLab(): JSX.Element {
  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-line bg-bg sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-6 py-3 flex items-center gap-4">
          <Link to="/" className="p-2 -ml-2 rounded-sm text-fg-3 no-underline hover:text-fg transition-colors">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <h1 className="text-base font-medium text-fg">Collapsed tool group</h1>
            <p className="text-xs text-fg-3">Sample agent turn</p>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-8">

        <div className="space-y-1.5">
          <AssistantText>First, let me understand the full rendering chain from useHarnessSession down to the renderer, so I know what needs to change.</AssistantText>

          <ToolCard label="Read" detail="src/web/chat/hooks/useHarnessSession.ts" icon={FileText} iconColor="text-fg-3" />

          <AssistantText>Now I need to understand how ConversationView uses `harnessMessages` and what needs to change. Let me trace the critical path.</AssistantText>

          <CollapsedToolGroup temporalState="historical" group={GROUP_CV_READS} />

          <AssistantText>Now let me see the conversation detail loading / hydration section — this is the historical pipeline I need to replace:</AssistantText>

          <CollapsedToolGroup temporalState="historical" group={GROUP_GREP_READS} />

          <AssistantText>{`OK. I can see the full picture now. Here's what needs to happen:

1. \`useHarnessSession\` needs to expose \`fetchHistory\`
2. ConversationView replaces the whole merge pipeline
3. Remove \`historicalMessages\`, \`optimisticUserMessage\` state`}</AssistantText>

          <EditCard {...EDITS.addFetchToDestructure} />

          <AssistantText>Now the big change — ConversationView. I need to expose `fetchHistory` from the harness hook, replace the entire merge pipeline with just `harnessMessages`, and remove the dead state.</AssistantText>

          <EditCard {...EDITS.removeDeadState} />

          <AssistantText>Remove the optimistic message clearing effect:</AssistantText>

          <EditCard {...EDITS.removeOptimisticEffect} />

          <AssistantText>Now replace the entire merge pipeline with just `harnessMessages`:</AssistantText>

          <EditCard {...EDITS.replaceMergePipeline} />

          <AssistantText>Let me typecheck to make sure everything compiles.</AssistantText>

          <ToolCard label="Bash" detail="pnpm typecheck 2>&1" icon={Terminal} iconColor="text-fg-3" />

          <AssistantText>Clean — no type errors. The entire historical message merge pipeline is gone. Messages now come from a single source: the harness event stream.</AssistantText>
        </div>

      </main>
    </div>
  );
}

// ---- Helpers ----

function AssistantText({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="py-2">
      <p className="text-[13px] text-fg leading-relaxed whitespace-pre-wrap">{children}</p>
    </div>
  );
}
