// ── Context ──
export { ToolkitProvider, useToolkitTheme, useAgentColor } from './context.js';
export type { ToolkitConfig } from './context.js';

// ── Types ──
export type {
  ToolResult,
  ChatMessage,
  DisplayContentBlock,
  QuestionDefinition,
  QuestionOption,
  CustomToolRenderer,
  BackgroundTaskOutput,
  BackgroundTaskState,
} from './types.js';

// ── Tokens ──
export { tk, PROSE_CLASSES, PROSE_CLASSES_SM } from './tokens.js';

// ── Utilities ──
export { cn } from './utils/cn.js';
export { detectLanguageFromPath } from './utils/language-detection.js';
export {
  formatFilePath,
  countLines,
  extractFileCount,
  parseTodos,
  extractDomain,
} from './utils/tool-utils.js';

// ── Main entry points ──
export { ToolUseRenderer } from './components/ToolUseRenderer.js';
export type { ToolUseRendererProps } from './components/ToolUseRenderer.js';
export { ToolContent } from './components/ToolContent.js';
export type { ToolContentProps } from './components/ToolContent.js';

// ── Card infrastructure (for building custom tool cards) ──
export { CollapsibleToolCard } from './components/CollapsibleToolCard.js';
export { CollapsedToolGroup } from './components/CollapsedToolGroup.js';
export type { CollapsedGroupData, ToolCallData, TemporalState } from './components/CollapsedToolGroup.js';

// ── Shared renderers (for building custom tool cards) ──
export { LazyCodeHighlight } from './components/shared/LazyCodeHighlight.js';
export { CodeHighlight } from './components/shared/CodeHighlight.js';
export { DiffViewer } from './components/shared/DiffViewer.js';
export {
  SearchResultContent,
  FetchResultContent,
  ProseResultContent,
} from './components/shared/WebResultContent.js';
export { ErrorBoundary } from './components/shared/ErrorBoundary.js';

// ── Individual tool components (for selective import or wrapping) ──
export { ReadTool } from './components/tools/ReadTool.js';
export { EditTool } from './components/tools/EditTool.js';
export { WriteTool } from './components/tools/WriteTool.js';
export { BashTool, summarizeCommand, unwrapShellCommand, parseBackgroundOutputPath } from './components/tools/BashTool.js';
export { PatchTool, parseUnifiedDiff, summarizePatchTargets, type PatchToolInput } from './components/tools/PatchTool.js';
export { SearchTool } from './components/tools/SearchTool.js';
export { WebTool } from './components/tools/WebTool.js';
export { TaskTool } from './components/tools/TaskTool.js';
export { TaskOutputTool } from './components/tools/TaskOutputTool.js';
export { TaskManagementTool } from './components/tools/TaskManagementTool.js';
export { TodoTool } from './components/tools/TodoTool.js';
export { PlanTool } from './components/tools/PlanTool.js';
export { AskUserQuestionTool } from './components/tools/AskUserQuestionTool.js';
export { FallbackTool } from './components/tools/FallbackTool.js';
export { ChromeDevToolsTool } from './components/tools/ChromeDevToolsTool.js';
export { MonitorTool } from './components/tools/MonitorTool.js';
export { ToolSearchTool } from './components/tools/ToolSearchTool.js';
export { ScheduleWakeupTool } from './components/tools/ScheduleWakeupTool.js';
export { TeamCreateTool, SendMessageTool, TeamDeleteTool } from './components/tools/TeamTools.js';

// ── MCP result cards (brand-aware; the default route for every MCP tool) ──
export {
  renderMcpTool,
  isMcpTool,
  isChromeDevToolsTool,
  mcpToolLabel,
  SlackCard,
  NotionCard,
  LinearCard,
  GitHubCard,
  McpCard,
  McpResultBody,
  brandFor,
  actionName,
  BRANDS,
  unwrapResult,
  summariseResult,
  type McpToolProps,
} from './components/tools/mcp/index.js';

// ── UI primitives (for building custom tool cards) ──
export { Collapsible, CollapsibleTrigger, CollapsibleContent } from './components/ui/collapsible.js';
export { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger, DialogClose } from './components/ui/dialog.js';
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from './components/ui/tooltip.js';

// ── Composer ──
export { Composer } from './components/Composer/index.js';
export type {
  ComposerProps,
  ComposerRef,
  ComposerCoreConfig,
  ComposerFeatureConfig,
  ComposerRuntimeConfig,
  FileSystemEntry,
  Command,
  EmojiSuggestion,
  AttachmentBlock,
} from './components/Composer/index.js';

// ── Reactions and emoji ──
export {
  ReactionChips,
  ReactionMenu,
  AddReactionButton,
  ReactionSheet,
  describeReactors,
  EmojiPicker,
  ComposerEmojiButton,
  useEmojiTable,
  useEmojiShortcodeSearch,
  loadEmoji,
  findEmoji,
  displayShortcode,
  shortcodeSuggestions,
  EMOJI_GROUPS,
  QUICK_REACTIONS,
} from './components/Reactions/index.js';
export type {
  Reactor,
  ReactionGroup,
  ReactionHandlers,
  ReactionChipsProps,
  ReactionMenuProps,
  AddReactionButtonProps,
  ReactionSheetProps,
  EmojiPickerProps,
  ComposerEmojiButtonProps,
  Emoji,
} from './components/Reactions/index.js';

// ── Hooks ──
export { useLocalStorage } from './hooks/useLocalStorage.js';
export { useAttachments } from './hooks/useAttachments.js';
export type { Attachment, UseAttachmentsReturn } from './hooks/useAttachments.js';
