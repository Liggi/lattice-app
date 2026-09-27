/**
 * useHarnessSession — wraps the harness useSession hook with Lattice-specific
 * transforms and concerns (messages, status mapping, event grouping).
 */

import { useMemo, useEffect, useRef } from 'react';
import { useSession } from '@liggi/agent-ui-harness/client';
import type { ActionTraceEntry, HydrationPhase } from '@liggi/agent-ui-harness/client';
import type {
  ContextCompactionData,
  InputSentData,
  SessionEvent,
  TurnEndData,
  RunEndData,
} from '@liggi/agent-ui-harness/protocol';
import type { Status as HarnessStatus, Activity, TurnUsage, BackgroundTaskState } from '@liggi/agent-ui-harness/protocol';
import { deriveBackgroundTaskStates, groupEvents, isCollapsedGroup, classifyTool, extractSubagentChildren, detectPendingMessages, createRunScopedCoalescer } from '@liggi/agent-ui-harness/protocol';
import { derivePendingWork, type PendingWork } from '@/harness/derive-pending-work.js';
import type { PendingMessage, ConsumedMessage } from '@liggi/agent-ui-harness/protocol';
import { foldInbox, type InboxFold, type InboxQueuedData } from '@/types/inbox';
import { foldAgentReactions, foldReactions } from '@/types/message-reactions';
import type { CollapsedGroup } from '@liggi/agent-ui-harness/protocol';
import type { ChatMessage, DisplayContentBlock, MessageAttribution } from '../types/index.js';
import type { CollapsedGroupData, ToolCallData } from '@liggi/agent-ui-toolkit';
import { useHydrationTrace } from './useHydrationTrace.js';
import type { Provider } from '@/types/unified-messages';
import type { CodexThreadGoal } from '@/services/process/codex-app-server-types';
import { PROJECT_NOTED_EVENT } from '@/types/project-state';
import { FEEDBACK_PROPOSED_EVENT, type FeedbackProposedData } from '@/types/feedback';
import {
  isWorkerEventType,
  isWorkerInput,
  stripContextRestore,
  stripPreamble,
  WORKER_REPORT_SUMMARY_EVENT,
  type WorkerAnsweredData,
  type WorkerReportedData,
  type WorkerReportSummaryData,
  type WorkerStartedData,
  type WorkerReassignedData,
  type WorkerMovedData,
} from '@/types/worker-events';

// ---- Render item types ----

export type RenderItem =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'group'; group: CollapsedGroupData; temporalState: 'active' | 'recent' | 'historical' }
  /** A coordinator's own tool use and thinking between two pieces of conversation, folded behind one line (see `utils/coordinator-thread.ts`). */
  | { kind: 'folded'; id: string; summary: string; latestHint: string | null; items: RenderItem[]; temporalState: 'active' | 'historical' };

/**
 * A message the session has not taken in yet: parked on a Claude session's
 * stdin, or in a session's inbox (`src/types/inbox.ts`). `undeliverable` is
 * set when a drain could not hand it over, so it says why.
 */
export interface PendingInput extends PendingMessage {
  undeliverable: string | null;
  /** Present when another agent sent it; absent on the user's own message. */
  attribution?: MessageAttribution;
}

// ---- Public interface ----

export interface UseHarnessSessionReturn {
  status: 'idle' | 'initializing' | 'streaming' | 'stopping';
  activity: Activity;
  connected: boolean;
  /** Hydration phase — see the HydrationPhase type in the harness. Consumers
   *  should treat messages arriving during 'hydrating' as catch-up, not live. */
  hydrationPhase: HydrationPhase;
  /** Whether the CLI process is alive (derived from events, not SSE transport). */
  processAlive: boolean;
  error: string | null;
  /** All messages for data derivation (toolResults, animations, pagination). */
  messages: ChatMessage[];
  /** Grouped render items — use this for rendering instead of messages. */
  renderItems: RenderItem[];
  /** Child messages keyed by parent Agent/Task tool_use id — for nested rendering in TaskTool. */
  childrenMessages: Record<string, ChatMessage[]>;
  /** Diagnostic trace of recent reducer actions for anomaly detection. */
  actionTrace: ActionTraceEntry[];
  /** Most recent turn's token usage (input/output/cache tokens + cost). */
  usage: TurnUsage | null;
  /** Model currently serving the session — from the latest top-level assistant
   *  message, falling back to the run:ready configured model. */
  sessionModel: string | null;
  /** True when the serving model differs from the configured model (provider
   *  capacity fallback, e.g. Fable → Opus). */
  sessionModelFallback: boolean;
  /** Latest Codex goal projected from harness lifecycle events. */
  codexGoal: CodexThreadGoal | null;
  /** True once this event stream has observed an explicit goal update/clear. */
  codexGoalEventSeen: boolean;
  /** Latest provider-neutral context compaction lifecycle. */
  compaction: ContextCompactionData | null;
  /** The latest compaction is its own turn, started by the compact command
   *  after a reply finished (automatically or from the compact control),
   *  rather than one the provider ran inside a turn that is still going. */
  compactionAfterReply: boolean;
  /** Timestamp (ms, this browser's clock) when the current active interval
   *  began — derived from server-stamped event timestamps, so it's stable
   *  across page refresh. Null when the session is idle. */
  activeStartTime: number | null;
  /**
   * Work still outstanding that will make this session speak again on its own —
   * a background command, a subagent, a workflow, a scheduled wakeup — or null
   * when nothing is. Null and 'idle' together mean the session is genuinely
   * waiting on the user.
   */
  pendingWork: PendingWork | null;
  /** Each background command's state (running, finished, lost), keyed by the tool_use_id that started it. */
  backgroundTaskStates: Record<string, BackgroundTaskState>;
  /** Seq of the newest worker:* event in the loaded window; null when none. */
  lastWorkerEventSeq: number | null;
  /** The user's emoji reactions, by the id of the message they are on. */
  reactions: ReadonlyMap<string, readonly string[]>;
  /** The agent's own reactions on the user's messages, by message id. */
  agentReactions: ReadonlyMap<string, readonly string[]>;
  /** Mid-turn injected messages waiting for consumption (floating above composer). */
  pendingMessages: PendingInput[];
  /** Send user input. `extra` is spread into the POST body by the harness client
   *  and threaded through SessionManager.send() → ProcessHandle.write(), which is
   *  how composer attachments reach the SDK: `{ attachments: ContentBlockParam[] }`. */
  send: (input: string, extra?: Record<string, unknown>) => Promise<void>;
  /** Compact context through the serving provider's native control path. */
  compact: () => Promise<void>;
  stop: () => Promise<void>;
  /** Force the SSE client to reconnect (e.g., after resume creates a harness session). */
  reconnect: () => void;
  /** Push a synthetic event into the local event stream (e.g., optimistic user message). */
  injectEvent: (event: SessionEvent) => void;
  /** Load older events from persistent storage for scroll-up pagination.
   *  Events are prepended to the front of the events array. */
  fetchHistory: (opts?: { limit?: number }) => Promise<{ hasMore: boolean }>;
}

export function useHarnessSession(
  conversationId: string | null,
  options?: { baseUrl?: string },
): UseHarnessSessionReturn {
  const baseUrl = options?.baseUrl ?? '/api/harness';

  const { status, activity, events, connected, hydrationPhase, processAlive, usage, error, send, compact, stop, reconnect, injectEvent, fetchHistory, actionTrace } = useSession(
    conversationId,
    {
      baseUrl,
      onEvent: (_event) => {},
    },
  );

  const inbox = useMemo(() => foldInbox(events), [events]);
  // The user's reactions, by message id. A reaction is logged after the message
  // it is on, so any loaded message has its reactions loaded too.
  const reactions = useMemo<ReadonlyMap<string, readonly string[]>>(() => {
    const byMessage = new Map<string, readonly string[]>();
    for (const [messageId, list] of foldReactions(events)) byMessage.set(messageId, list.map((reaction) => reaction.emoji));
    return byMessage;
  }, [events]);
  const agentReactions = useMemo<ReadonlyMap<string, readonly string[]>>(() => foldAgentReactions(events), [events]);
  const { pending: pendingMessages, consumed: consumedMessages } = useMemo(() => placeWaitingMessages(events, inbox), [events, inbox]);

  const eventContext = useMemo(() => deriveEventContext(events), [events]);

  // Transform harness events → ChatMessage[] (for data derivation)
  const messages = useMemo(() => eventsToMessages(events, eventContext.providerBySeq), [events, eventContext.providerBySeq]);

  // Group events → render items + subagent children (for rendering).
  // `isStreaming` feeds CollapsedToolGroup.isActive — gate on hydrationPhase
  // for the same reason as latticeStatus below: catch-up replay transiently
  // derives 'streaming' between `content` and `turn:end`, and we don't want
  // historical tool cards flashing their active spinner.
  const isStreaming = status === 'streaming' && hydrationPhase === 'ready';
  const { renderItems, childrenMessages } = useMemo(
    () => eventsToRenderItems(events, isStreaming, eventContext.providerBySeq, pendingMessages, consumedMessages, inbox.hiddenInputSeqs),
    [events, isStreaming, eventContext.providerBySeq, pendingMessages, consumedMessages, inbox.hiddenInputSeqs],
  );

  // Map harness status → Lattice status.
  //
  // While the client is still hydrating, SSE replay delivers events
  // incrementally. Between receipt of `content` and `turn:end`, `deriveStatus`
  // transiently reports 'streaming' before settling on 'idle'. Propagating
  // that transient makes the status bar flash "idle → Working → idle" on
  // every cold load, and every downstream indicator keyed on status
  // (CollapsedToolGroup.isActive, the live border)
  // flickers with it.
  //
  // Gating at the single source — here — keeps the catch-up window quiet
  // across every status-derived surface at once, instead of gating each one.
  // When hydration completes, the real status takes over in one clean
  // transition.
  const latticeStatus = hydrationPhase === 'hydrating' ? 'idle' : mapStatus(status);

  // Outstanding work, from the event stream. Deliberately not the harness's
  // `hasRunningBackgroundTasks`: that one counts `local_bash` only, because it
  // feeds the background-task tray, where subagents render through TaskTool
  // instead. The composer is asking a different question — "will this session
  // speak again without me?" — and a running subagent answers yes. Reading the
  // narrow signal there is what let a live subagent show as Ready.
  const pendingWork = useMemo(() => derivePendingWork(events), [events]);
  const backgroundTaskStates = useMemo(() => deriveBackgroundTaskStates(events), [events]);

  // Seq of the newest worker:* or project:noted event in the window. The
  // coordinator panel refetches its state from the server (the full log, not
  // this paginated window) each time this moves.
  const lastWorkerEventSeq = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (isWorkerEventType(events[i].type) || (events[i].type as string) === PROJECT_NOTED_EVENT) return events[i].seq;
    }
    return null;
  }, [events]);

  // Serving model: prefer the latest top-level assistant message's model (what
  // actually served) over the run:ready configured model. Fallback detection
  // uses a prefix check so alias vs dated-id forms of the same model
  // (e.g. "claude-opus-4-8" vs "claude-opus-4-8-20250815") don't false-alarm.
  const { configuredModel, servingModel } = eventContext;
  const sessionModel = servingModel ?? configuredModel;
  const sessionModelFallback = Boolean(
    servingModel && configuredModel
    && !servingModel.startsWith(configuredModel)
    && !configuredModel.startsWith(servingModel),
  );

  // Derive the start of the current active interval from server-stamped event
  // timestamps. The active interval is the run of events after the most recent
  // turn boundary (turn:end / run:end / run:error). On cold-load the SSE handler
  // scopes replay to include the previous turn boundary, so this finds it.
  // For sessions still on their first turn (no boundary yet), fall back to the
  // first event's timestamp. Null when status is idle.
  const serverClockLead = useServerClockLead(events);
  const activeStartTime = useMemo(() => {
    const start = deriveActiveStartTime(events, latticeStatus);
    return start === null ? null : start - serverClockLead;
  }, [events, latticeStatus, serverClockLead]);

  // ---- Hydration trace (mobile cold-load / SSE-reconnect diagnostic) ----
  //
  // Posts structured events to /api/debug/hydration-trace on every relevant
  // transition. Each event is tagged with a per-tab `traceId` so one mobile
  // session can be filtered out of server.log. See debug-hydration-trace.routes
  // for the rationale and the grep recipe.
  useHydrationTrace({
    conversationId,
    rawStatus: status,
    latticeStatus,
    hydrationPhase,
    connected,
    processAlive,
    eventCount: events.length,
    lastEventSeq: events.length > 0 ? events[events.length - 1].seq : null,
    lastEventType: events.length > 0 ? events[events.length - 1].type : null,
  });

  // Expose a debug snapshot on window for devtools investigations.
  // Paired with GET /api/debug/sessions/:id/harness-snapshot — this is the
  // client-side counterpart, surfacing the values that only exist post-derive
  // in the browser (hydrationPhase, latticeStatus, actionTrace). When
  // investigating cold-load/hydration/replay visual bugs, paste
  //   window.__latticeDebug
  // from devtools into the report — it beats screen-recordings for the
  // timing-sensitive state transitions. See memory
  // `reference_lattice_hydration_gates.md` for the gate architecture this
  // helps diagnose.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const w = window as unknown as {
      __latticeDebug?: Record<string, unknown>;
    };
    w.__latticeDebug = {
      conversationId,
      rawStatus: status,
      latticeStatus,
      hydrationPhase,
      connected,
      processAlive,
      pendingWork,
      sessionModel,
      sessionModelFallback,
      eventCount: events.length,
      lastEventSeq: events.length > 0 ? events[events.length - 1].seq : null,
      lastEventType: events.length > 0 ? events[events.length - 1].type : null,
      actionTrace: actionTrace.slice(-40),
      updatedAt: new Date().toISOString(),
    };
  }, [
    conversationId,
    status,
    latticeStatus,
    hydrationPhase,
    connected,
    processAlive,
    pendingWork,
    sessionModel,
    sessionModelFallback,
    events,
    actionTrace,
  ]);

  return {
    status: latticeStatus,
    activity,
    connected,
    hydrationPhase,
    processAlive,
    error,
    messages,
    renderItems,
    childrenMessages,
    usage,
    sessionModel,
    sessionModelFallback,
    codexGoal: eventContext.codexGoal,
    codexGoalEventSeen: eventContext.codexGoalEventSeen,
    compaction: eventContext.compaction,
    compactionAfterReply: eventContext.compactionAfterReply,
    activeStartTime,
    pendingWork,
    backgroundTaskStates,
    pendingMessages,
    actionTrace,
    lastWorkerEventSeq,
    reactions,
    agentReactions,
    send,
    compact,
    stop,
    reconnect,
    injectEvent,
    fetchHistory,
  };
}

// ---- Active interval start derivation ----

/**
 * How far the server's clock runs ahead of this browser's, in ms (0 if not).
 * An event can't be stamped later than the moment it arrives, so each event
 * whose timestamp is ahead of the browser clock on arrival proves a lead.
 */
function useServerClockLead(events: readonly SessionEvent[]): number {
  const leadRef = useRef(0);
  const lastSeenRef = useRef<SessionEvent | undefined>(undefined);
  const last = events[events.length - 1];
  if (last && last !== lastSeenRef.current) {
    lastSeenRef.current = last;
    leadRef.current = Math.max(leadRef.current, last.timestamp - Date.now());
  }
  return leadRef.current;
}

function deriveActiveStartTime(
  events: readonly SessionEvent[],
  status: 'idle' | 'initializing' | 'streaming' | 'stopping',
): number | null {
  if (status === 'idle') return null;
  if (events.length === 0) return null;

  // Walk back to find the most recent turn boundary. The next event after
  // it (or events[0] if none) is the start of the current active interval.
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i].type;
    if (t === 'turn:end' || t === 'run:end' || t === 'run:error') {
      return events[i + 1]?.timestamp ?? null;
    }
  }
  return events[0].timestamp;
}

// ---- Status mapping ----

function mapStatus(status: HarnessStatus): 'idle' | 'initializing' | 'streaming' | 'stopping' {
  switch (status) {
    case 'idle':
      return 'idle';
    case 'starting':
      return 'initializing';
    case 'streaming':
      return 'streaming';
    case 'stopping':
      return 'stopping';
  }
}

// ---- Events → RenderItem[] + childrenMessages ----

/**
 * Messages the session has not taken in yet come from two places. A pre-inbox
 * Claude log has a mid-turn message on stdin, and the harness detects when
 * the turn read it. Otherwise the message is an inbox item: its queued event
 * is the message, the `input:sent` that carried it (the batch the model
 * read) is hidden, and it floats above the composer until its `input:read`,
 * where it then enters the thread.
 * A worker's report or question is delivered as an input too; it is not
 * the user's message and the worker event already shows it, so it neither
 * floats above the composer nor renders at its consumption point.
 */
export function placeWaitingMessages(events: SessionEvent[], inbox: InboxFold): { pending: PendingInput[]; consumed: ConsumedMessage[] } {
  const inputText = (event: SessionEvent): string => stripContextRestore((event.data as { text?: string }).text ?? '');
  const detected = detectPendingMessages(events);
  const pending: PendingInput[] = [];
  const consumed: ConsumedMessage[] = [];
  for (const p of detected.pending) {
    const text = stripContextRestore(p.text);
    if (isWorkerInput(text) || inbox.hiddenInputSeqs.has(p.inputEvent.seq)) continue;
    pending.push({ ...p, text, undeliverable: null });
  }
  for (const c of detected.consumed) {
    if (isWorkerInput(inputText(c.inputEvent)) || inbox.hiddenInputSeqs.has(c.inputEvent.seq)) continue;
    consumed.push(c);
  }
  const inputBySeq = new Map<number, SessionEvent>();
  for (const event of events) {
    if (event.type === 'input:sent') inputBySeq.set(event.seq, event);
  }
  for (const item of inbox.items) {
    // Another agent's message goes where the user's would: it is a message to
    // this session either way, and the thread has no other line for it. It
    // carries who sent it, so it is not read as theirs (see MessageItem).
    if (item.legacy || (item.source !== 'user' && item.source !== 'agent')) continue;
    const attribution = item.source === 'agent'
      ? { sender: item.sender, passedOn: item.passedOn }
      : undefined;
    if (item.readBySeq === null) {
      pending.push({ inputEvent: item.event, text: item.text, undeliverable: item.undeliverable, attribution });
      continue;
    }
    // It enters the thread where the session took it in. A message sent into
    // a running Claude turn is read only once the current tool finishes, so
    // the batch that carried it is the wrong place; the receipt is not.
    const consumedByEvent = item.readEvent ?? inputBySeq.get(item.readBySeq);
    if (consumedByEvent) consumed.push({ inputEvent: item.event, consumedByEvent });
  }
  pending.sort((a, b) => a.inputEvent.seq - b.inputEvent.seq);
  return { pending, consumed };
}

/**
 * The provenance an `input:queued` event carries (`src/types/inbox.ts`).
 * Absent for the user's own message, so the bubble stays unlabelled.
 */
function attributionOf(event: SessionEvent): MessageAttribution | undefined {
  const data = event.data as Partial<InboxQueuedData>;
  if (data.source !== 'agent') return undefined;
  return { sender: data.sender ?? null, passedOn: data.passedOn === true };
}

/**
 * Report summaries keyed by the seq of the `worker:reported` event each one
 * belongs to. The summary is written after the report and lands later in the
 * log, so the card cannot read it off its own event.
 */
function reportSummariesBySeq(events: readonly SessionEvent[]): Map<number, WorkerReportSummaryData> {
  const summaries = new Map<number, WorkerReportSummaryData>();
  for (const event of events) {
    if ((event.type as string) !== WORKER_REPORT_SUMMARY_EVENT) continue;
    const data = event.data as Partial<WorkerReportSummaryData>;
    if (typeof data?.reportSeq !== 'number' || !data.title || !data.text) continue;
    summaries.set(data.reportSeq, data as WorkerReportSummaryData);
  }
  return summaries;
}

function eventsToRenderItems(
  events: readonly SessionEvent[],
  isStreaming: boolean,
  providerBySeq: ReadonlyMap<number, Provider>,
  pendingMessages: PendingMessage[] = [],
  consumedMessages: ConsumedMessage[] = [],
  hiddenInputSeqs: ReadonlySet<number> = new Set(),
): { renderItems: RenderItem[]; childrenMessages: Record<string, ChatMessage[]> } {
  // Build a set of input:sent event seqs that should be suppressed from
  // inline rendering (they're either pending, will be placed at the
  // consumption point instead, or carried an inbox batch whose items are
  // shown by their own events).
  const suppressedInputSeqs = new Set<number>(hiddenInputSeqs)
  for (const p of pendingMessages) suppressedInputSeqs.add(p.inputEvent.seq)
  for (const c of consumedMessages) suppressedInputSeqs.add(c.inputEvent.seq)

  const reportSummaries = reportSummariesBySeq(events)

  // Build a map: consuming event seq → consumed input:sent events to insert before it
  const insertBeforeSeq = new Map<number, ConsumedMessage[]>()
  for (const c of consumedMessages) {
    const seq = c.consumedByEvent.seq
    const existing = insertBeforeSeq.get(seq)
    if (existing) {
      existing.push(c)
    } else {
      insertBeforeSeq.set(seq, [c])
    }
  }

  // Extract subagent child events before grouping
  const { topLevel, childrenByToolUseId } = extractSubagentChildren(events);

  const grouped = groupEvents(topLevel);
  const items: RenderItem[] = [];
  const coalescer = chatMessageCoalescer((msg) => items.push({ kind: 'message', message: msg }));

  for (let i = 0; i < grouped.length; i++) {
    const item = grouped[i];

    if (isCollapsedGroup(item)) {
      const isLast = i === grouped.length - 1;
      const isActive = isLast && isStreaming;

      // Check if any event in this group is a consumption point
      for (const groupEvent of (item as CollapsedGroup).events) {
        const toInsert = insertBeforeSeq.get(groupEvent.seq)
        if (toInsert) {
          for (const consumed of toInsert) {
            const data = consumed.inputEvent.data as { text?: string }
            if (data.text) {
              items.push({
                kind: 'message',
                message: {
                  id: `h-${consumed.inputEvent.seq}`,
                  messageId: `h-${consumed.inputEvent.seq}`,
                  type: 'user',
                  content: data.text,
                  timestamp: new Date(consumed.inputEvent.timestamp).toISOString(),
                  provider: providerBySeq.get(consumed.inputEvent.seq) ?? 'claude',
                  attribution: attributionOf(consumed.inputEvent),
                },
              })
            }
          }
        }
      }

      items.push({
        kind: 'group',
        group: collapsedGroupToData(item, isActive),
        temporalState: isActive ? 'active' : 'historical',
      });
    } else {
      // Check if this event is a consumption point — insert consumed messages
      // before it. This comes before the suppression below: an inbox item's
      // consumption point is the hidden batch input that carried it.
      const toInsert = insertBeforeSeq.get(item.seq)
      if (toInsert) {
        for (const consumed of toInsert) {
          const data = consumed.inputEvent.data as { text?: string }
          if (data.text) {
            items.push({
              kind: 'message',
              message: {
                id: `h-${consumed.inputEvent.seq}`,
                messageId: `h-${consumed.inputEvent.seq}`,
                type: 'user',
                content: data.text,
                timestamp: new Date(consumed.inputEvent.timestamp).toISOString(),
                provider: providerBySeq.get(consumed.inputEvent.seq) ?? 'claude',
                attribution: attributionOf(consumed.inputEvent),
              },
            })
          }
        }
      }

      // Suppress input:sent events that are pending or consumed (rendered
      // elsewhere). Skips never include run:start, so the coalescer still
      // sees every scope boundary via the onEvent call below.
      if (item.type === 'input:sent' && suppressedInputSeqs.has(item.seq)) continue;

      // Result events exist only for toolResults derivation — they have no
      // visual representation (MessageItem returns null for tool_result-only
      // user messages). Skip them to avoid empty wrapper divs.
      if (item.type === 'result') continue;

      coalescer.onEvent(item, eventToMessage(item, providerBySeq, reportSummaries));
    }
  }

  // Convert child events to ChatMessages for each subagent
  const childrenMessages: Record<string, ChatMessage[]> = {};
  for (const [toolUseId, childEvents] of Object.entries(childrenByToolUseId)) {
    const msgs: ChatMessage[] = [];
    const childCoalescer = chatMessageCoalescer((msg) => msgs.push(msg));
    for (const event of childEvents) {
      childCoalescer.onEvent(event, eventToMessage(event, providerBySeq));
    }
    if (msgs.length > 0) {
      childrenMessages[toolUseId] = msgs;
    }
  }

  return { renderItems: items, childrenMessages };
}

function collapsedGroupToData(group: CollapsedGroup, isActive: boolean): CollapsedGroupData {
  const toolCalls: ToolCallData[] = [];
  let latestHint: string | undefined;

  // Walk group events and pair content (tool_use) with result (tool_result)
  const pendingToolUses: Array<{ name: string; input: Record<string, unknown>; id: string }> = [];

  for (const event of group.events) {
    if (event.type === 'content') {
      const data = event.data as { blocks?: Array<Record<string, unknown>> };
      for (const block of data.blocks ?? []) {
        if (block.type === 'tool_use') {
          pendingToolUses.push({
            name: block.name as string,
            input: block.input as Record<string, unknown>,
            id: block.id as string,
          });
        }
      }
    } else if (event.type === 'result') {
      const data = event.data as { blocks?: Array<Record<string, unknown>> };
      for (const block of data.blocks ?? []) {
        if (block.type === 'tool_result') {
          const toolUseId = block.tool_use_id as string;
          const matchIdx = pendingToolUses.findIndex((t) => t.id === toolUseId);
          const toolUse = matchIdx >= 0 ? pendingToolUses.splice(matchIdx, 1)[0] : null;

          if (toolUse) {
            // Skip select: ToolSearch — internal schema pre-loading, not meaningful
            if (toolUse.name === 'ToolSearch' && typeof toolUse.input.query === 'string' && toolUse.input.query.startsWith('select:')) {
              continue;
            }
            const classification = classifyTool(toolUse.name, toolUse.input);
            toolCalls.push({
              tool: mapToolType(toolUse.name),
              input: classification.detail ?? toolUse.name,
              filePath: (toolUse.input.file_path as string) ?? undefined,
              resultContent: typeof block.content === 'string' ? block.content : undefined,
              status: block.is_error ? 'error' : 'success',
            });
          }
        }
      }
    }
  }

  // Any remaining pending tool_uses without results → pending status
  for (const toolUse of pendingToolUses) {
    if (toolUse.name === 'ToolSearch' && typeof toolUse.input.query === 'string' && toolUse.input.query.startsWith('select:')) continue;
    const classification = classifyTool(toolUse.name, toolUse.input);
    toolCalls.push({
      tool: mapToolType(toolUse.name),
      input: classification.detail ?? toolUse.name,
      filePath: (toolUse.input.file_path as string) ?? undefined,
      status: 'pending',
    });
    latestHint = classification.summary.present + (classification.detail ? ` ${classification.detail}` : '');
  }

  // Use the last completed tool for the hint if nothing is pending
  if (!latestHint && toolCalls.length > 0) {
    const last = toolCalls[toolCalls.length - 1];
    latestHint = last.input;
  }

  const firstTimestamp = group.events[0]?.timestamp ?? Date.now();

  return {
    id: `group-${firstTimestamp}`,
    summary: group.summary,
    toolCalls,
    isActive: isActive || undefined,
    latestHint: isActive ? latestHint : undefined,
    timestamp: new Date(firstTimestamp).toISOString(),
  };
}

function mapToolType(name: string): ToolCallData['tool'] {
  switch (name) {
    case 'Read': return 'read';
    case 'Grep': return 'grep';
    case 'Glob': return 'glob';
    case 'LS': return 'ls';
    case 'WebSearch': return 'web-search';
    case 'WebFetch': return 'web-fetch';
    case 'ToolSearch': return 'tool-search';
    default: return 'read';
  }
}

// ---- Events → ChatMessage transform ----

function eventToMessage(
  event: SessionEvent,
  providerBySeq: ReadonlyMap<number, Provider>,
  /** Report summaries by the seq of the report they belong to; see `reportSummariesBySeq`. */
  reportSummaries: ReadonlyMap<number, WorkerReportSummaryData> = new Map(),
): ChatMessage | null {
  const provider = providerBySeq.get(event.seq) ?? 'claude';

  switch (event.type) {
    case 'content': {
      const data = event.data as { blocks?: Array<Record<string, unknown>>; messageId?: string };
      if (!data.blocks || data.blocks.length === 0) return null;

      const blocks = data.blocks.map(toDisplayBlock).filter(Boolean) as DisplayContentBlock[];
      if (blocks.length === 0) return null;
      const messageId = data.messageId ? `h-${data.messageId}` : `h-${event.seq}`;

      return {
        id: messageId,
        messageId,
        type: 'assistant',
        content: blocks,
        timestamp: new Date(event.timestamp).toISOString(),
        provider,
      };
    }

    case 'result': {
      const data = event.data as { blocks?: Array<Record<string, unknown>> };
      if (!data.blocks || data.blocks.length === 0) return null;

      const blocks: DisplayContentBlock[] = [];
      for (const block of data.blocks) {
        if (block.type === 'tool_result') {
          blocks.push({
            type: 'tool_result',
            tool_use_id: block.tool_use_id as string,
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            is_error: (block.is_error as boolean) ?? false,
          } as DisplayContentBlock);
        }
      }
      if (blocks.length === 0) return null;

      return {
        id: `h-${event.seq}`,
        messageId: `h-${event.seq}`,
        type: 'user',
        content: blocks,
        timestamp: new Date(event.timestamp).toISOString(),
        provider,
      };
    }

    case 'input:sent': {
      const raw = event.data as { text?: string; source?: string; blocks?: Array<Record<string, unknown>> };
      if (raw.source === 'command') return null;
      // The server puts a coordinator's or worker's standing preamble in front
      // of its first message, and a restored preamble and worker roster in
      // front of the next input after a compaction; the thread shows the
      // message as it was written.
      const data = raw.text ? { ...raw, text: stripPreamble(stripContextRestore(raw.text)) } : raw;
      // A worker's report or question delivered into a coordinator: the
      // worker event carries it in its own shape, so the raw input is hidden.
      if (data.text && isWorkerInput(data.text)) return null;
      const attachmentBlocks = Array.isArray(data.blocks) ? data.blocks : [];
      // A message can be attachments-only (a bare screenshot paste), so an
      // empty text is only "nothing to render" when there are no blocks either.
      if (!data.text && attachmentBlocks.length === 0) return null;

      // Text-only stays a plain string — MessageItem's media rendering keys off
      // an array content, and every existing consumer of the string form is
      // untouched. With attachments, emit blocks first then the text block,
      // matching the order the SDK receives them.
      const content: string | DisplayContentBlock[] = attachmentBlocks.length === 0
        ? data.text!
        : [
            ...(attachmentBlocks as unknown as DisplayContentBlock[]),
            ...(data.text ? [{ type: 'text', text: data.text } as DisplayContentBlock] : []),
          ];

      return {
        id: `h-${event.seq}`,
        messageId: `h-${event.seq}`,
        type: 'user',
        content,
        timestamp: new Date(event.timestamp).toISOString(),
        provider,
      };
    }

    case 'run:error': {
      const data = event.data as { message?: string };
      return {
        id: `h-${event.seq}`,
        messageId: `h-${event.seq}`,
        type: 'error',
        content: data.message ?? 'Unknown error',
        timestamp: new Date(event.timestamp).toISOString(),
        provider,
      };
    }

    case 'run:end': {
      // Only a process that stopped being reachable with work still running
      // is news; every other run:end is an ordinary exit the thread skips.
      const data = event.data as RunEndData;
      if (data.reason !== 'process_lost' || !data.lostTasks?.length) return null;
      const one = data.lostTasks.length === 1;
      const names = data.lostTasks.map((t) => t.description ?? t.taskId);
      return {
        id: `h-${event.seq}`,
        messageId: `h-${event.seq}`,
        type: 'error',
        errorTitle: one ? 'Background task lost' : 'Background tasks lost',
        content: `${one ? names[0] : names.map((n) => `• ${n}`).join('\n')}\n\n`
          + `Lattice lost contact with the process running ${one ? 'it' : 'them'} when its server or daemon restarted, `
          + `so ${one ? 'its result' : 'their results'} will not arrive here. Send a message to carry on.`,
        timestamp: new Date(event.timestamp).toISOString(),
        provider,
      };
    }

    case 'context:compaction': {
      const data = event.data as ContextCompactionData;
      if (data.phase !== 'failed') return null;
      return {
        id: `h-${event.seq}`,
        messageId: `h-${event.seq}`,
        type: 'error',
        content: data.error
          ? `Context compaction failed: ${data.error}`
          : 'Context compaction failed.',
        timestamp: new Date(event.timestamp).toISOString(),
        provider,
      };
    }

    case 'turn:end': {
      const data = event.data as TurnEndData;
      if (!data.compact) return null;
      return {
        id: `h-compact-${event.seq}`,
        messageId: `h-compact-${event.seq}`,
        type: 'system',
        content: 'Context compacted',
        timestamp: new Date(event.timestamp).toISOString(),
        provider,
        systemSubtype: 'compact_boundary',
        compactMetadata: {
          ...(typeof data.trigger === 'string' ? { trigger: data.trigger } : {}),
          ...(typeof data.preTokens === 'number' ? { preTokens: data.preTokens } : {}),
          ...(typeof data.postTokens === 'number' ? { postTokens: data.postTokens } : {}),
          ...(typeof data.durationMs === 'number' ? { durationMs: data.durationMs } : {}),
          ...(typeof data.costUsd === 'number' ? { costUsd: data.costUsd } : {}),
        },
      };
    }

    default: {
      // An agent's feedback proposal, written by the server into the chat the
      // user reads (a worker's goes to its coordinator's). A card to act on.
      if ((event.type as string) === FEEDBACK_PROPOSED_EVENT) {
        return {
          id: `h-${event.seq}`,
          messageId: `h-${event.seq}`,
          type: 'system',
          content: '',
          timestamp: new Date(event.timestamp).toISOString(),
          provider,
          systemSubtype: 'feedback',
          feedbackProposal: event.data as FeedbackProposedData,
        };
      }
      // Worker events, written by the server into a coordinator's log. Started,
      // reassigned, answered and reported are thread items; asked is not — the
      // open question lives on the worker's card until the coordinator answers
      // it.
      if (isWorkerEventType(event.type) && event.type !== 'worker:asked') {
        return {
          id: `h-${event.seq}`,
          messageId: `h-${event.seq}`,
          type: 'system',
          content: '',
          timestamp: new Date(event.timestamp).toISOString(),
          provider,
          systemSubtype: 'worker',
          workerEvent: {
            type: event.type,
            data: event.data as WorkerStartedData | WorkerReassignedData | WorkerAnsweredData | WorkerReportedData | WorkerMovedData,
            // Written after the report and carried on its own event, so a
            // report keeps its card and gains the summary when it lands.
            ...(event.type === 'worker:reported' && reportSummaries.has(event.seq)
              ? { reportSummary: reportSummaries.get(event.seq)! }
              : {}),
          },
        };
      }
      return null;
    }
  }
}

function deriveEventContext(events: readonly SessionEvent[]): {
  providerBySeq: ReadonlyMap<number, Provider>;
  codexGoal: CodexThreadGoal | null;
  codexGoalEventSeen: boolean;
  compaction: ContextCompactionData | null;
  compactionAfterReply: boolean;
  configuredModel: string | null;
  servingModel: string | null;
} {
  const providerBySeq = new Map<number, Provider>();
  let provider: Provider = 'claude';
  let codexGoal: CodexThreadGoal | null = null;
  let codexGoalEventSeen = false;
  let compaction: ContextCompactionData | null = null;
  let compactionAfterReply = false;
  let lastInputIsCompactCommand = false;
  let configuredModel: string | null = null;
  let servingModel: string | null = null;

  for (const event of events) {
    if (event.type === 'run:start') {
      const data = event.data as { config?: { extra?: { provider?: unknown } } };
      provider = data.config?.extra?.provider === 'codex' ? 'codex' : 'claude';
    } else if (event.type === 'run:ready') {
      const data = event.data as { model?: string };
      if (data.model) configuredModel = data.model;
    } else if (event.type === 'content') {
      // Subagent messages (parentToolUseId set) can run on a different model
      // than the main loop — only top-level messages reflect the session model.
      const data = event.data as { model?: string; parentToolUseId?: string | null };
      if (data.model && !data.parentToolUseId) servingModel = data.model;
    }

    providerBySeq.set(event.seq, provider);

    const eventType = event.type as string;
    if (eventType === 'goal:updated') {
      const data = event.data as { goal?: CodexThreadGoal };
      codexGoal = data.goal ?? null;
      codexGoalEventSeen = true;
    } else if (eventType === 'goal:cleared') {
      codexGoal = null;
      codexGoalEventSeen = true;
    } else if (eventType === 'input:sent') {
      const data = event.data as InputSentData;
      lastInputIsCompactCommand = data.source === 'command' && data.text === '/compact';
    } else if (eventType === 'context:compaction') {
      compaction = event.data as ContextCompactionData;
      if (compaction.phase === 'started') compactionAfterReply = lastInputIsCompactCommand;
    } else if ((eventType === 'run:end' || eventType === 'run:error')
      && compaction?.phase === 'started') {
      compaction = {
        phase: 'failed',
        error: 'The provider stopped before confirming compaction.',
      };
    }
  }

  return { providerBySeq, codexGoal, codexGoalEventSeen, compaction, compactionAfterReply, configuredModel, servingModel };
}

function mergeDisplayContent(
  existing: string | DisplayContentBlock[],
  incoming: string | DisplayContentBlock[],
): string | DisplayContentBlock[] {
  if (typeof existing === 'string' || typeof incoming === 'string') {
    return `${typeof existing === 'string' ? existing : ''}${typeof incoming === 'string' ? incoming : ''}`;
  }

  const merged = [...existing];
  for (const block of incoming) {
    const last = merged[merged.length - 1] as Record<string, unknown> | undefined;
    const next = block as Record<string, unknown>;
    if (last?.type === 'text' && next.type === 'text') {
      last.text = `${typeof last.text === 'string' ? last.text : ''}${typeof next.text === 'string' ? next.text : ''}`;
      continue;
    }
    if (last?.type === 'thinking' && next.type === 'thinking') {
      const separator = last.thinking && next.thinking ? '\n' : '';
      last.thinking = `${typeof last.thinking === 'string' ? last.thinking : ''}${separator}${typeof next.thinking === 'string' ? next.thinking : ''}`;
      continue;
    }
    merged.push(block);
  }
  return merged;
}

// The coalesce SCOPE rule (span a run, reset at run:start, never reset at
// turn boundaries) lives in the harness — createRunScopedCoalescer — with the
// contract tests that pin it. This hook only supplies what a ChatMessage is
// and how two fragments merge.

function coalesceInto(target: ChatMessage, msg: ChatMessage): void {
  target.content = mergeDisplayContent(target.content, msg.content);
  target.timestamp = msg.timestamp;
}

function coalesceKey(msg: ChatMessage): string {
  return `${msg.type} ${msg.provider} ${msg.messageId}`;
}

function chatMessageCoalescer(append: (msg: ChatMessage) => void) {
  return createRunScopedCoalescer<ChatMessage>({
    keyOf: coalesceKey,
    merge: coalesceInto,
    append,
  });
}

/**
 * Exported for unit testing — pure, no hook state. Derives report summaries
 * from the same events, as `eventsToRenderItems` does, so what a test sees is
 * what the thread renders.
 */
export function eventsToMessages(
  events: readonly SessionEvent[],
  providerBySeq: ReadonlyMap<number, Provider>,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const reportSummaries = reportSummariesBySeq(events);
  const coalescer = chatMessageCoalescer((msg) => messages.push(msg));
  for (const event of events) {
    coalescer.onEvent(event, eventToMessage(event, providerBySeq, reportSummaries));
  }
  return messages;
}

function toDisplayBlock(block: Record<string, unknown>): DisplayContentBlock | null {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text as string };
    case 'thinking':
      return { type: 'thinking', thinking: block.thinking as string };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id as string,
        name: block.name as string,
        input: block.input as Record<string, unknown>,
      } as DisplayContentBlock;
    default:
      return null;
  }
}
