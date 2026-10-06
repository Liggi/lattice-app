export type {
  SessionEvent,
  EventType,
  ContentBlock,
  ResultBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  Base64Source,
  ImageBlock,
  DocumentBlock,
  AttachmentBlock,
  RunStartData,
  RunReadyData,
  RunEndData,
  LostTask,
  RunErrorData,
  ContentData,
  ResultData,
  TurnEndData,
  TurnError,
  ContextCompactionData,
  ContextCompactionPhase,
  InputSentData,
  PastedSpan,
  TaskStartedData,
  TaskUpdatedData,
  TaskNotificationData,
  ApiUsage,
} from './events.js'

export { EVENT_TYPES, ATTACHMENTS_EXTRA_KEY, attachmentBlocksFromExtra, PASTES_EXTRA_KEY, parsePastedSpans, pastedSpansFromExtra } from './events.js'

export { deriveStatus, deriveActivity, deriveProcessAlive, deriveUsage, deriveBackgroundTasks, deriveBackgroundTaskStates, deriveUnfinishedTasks, hasRunningBackgroundTasks, deriveScheduledWakeup, derivePlanOutcomes } from './derive.js'
export type { Status, Activity, TurnUsage, BackgroundTask, BackgroundTaskState, DerivedScheduledWakeup } from './derive.js'

export { createRunScopedCoalescer } from './coalesce.js'
export type { RunScopedCoalescer, RunScopedCoalescerOptions } from './coalesce.js'

export { classifyTool, groupEvents, isCollapsedGroup, extractSubagentChildren, detectPendingMessages } from './classify/index.js'
export type {
  ToolClassification,
  ToolCategory,
  CollapsedGroup,
  GroupedEvent,
  SubagentExtraction,
  PendingMessage,
  ConsumedMessage,
  PendingMessageDetection,
} from './classify/index.js'
