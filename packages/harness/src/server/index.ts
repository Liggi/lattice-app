export { SessionManager } from './session-manager.js'
export type {
  StartConfig,
  SessionManagerOptions,
  SessionDiagnostics,
  ScheduledWakeupInfo,
  FollowUpSpawnInfo,
  Logger,
} from './session-manager.js'

export { EventLog } from './event-log.js'
export type { EventLogOptions } from './event-log.js'

export type { EventStorageAdapter } from './event-storage.js'

export { createSSEHandler } from './sse-handler.js'
export type { SSEHandlerOptions } from './sse-handler.js'

export { createWebSSEHandler } from './sse-handler-web.js'
export type { WebSSEHandlerOptions } from './sse-handler-web.js'

export { normalizeClaude, isIgnoredClaudeEvent } from './normalize-claude.js'
export type { NormalizedEvent } from './normalize-claude.js'

export { JsonLinesParser } from './json-lines-parser.js'

export type {
  ProcessAdapter,
  ProcessHandle,
  SpawnConfig,
  SteerRequest,
  SteerOutcome,
  SteerStage,
} from './process-adapter.js'

export { ClaudeCliAdapter } from './claude-cli-adapter.js'

export {
  ClaudeInteractiveAdapter,
  findClaudeBin,
  DEFAULT_STRIPPED_ENV_KEYS,
} from './claude-interactive-adapter.js'
export type { ClaudeInteractiveAdapterOptions } from './claude-interactive-adapter.js'

export {
  CassetteRecorder,
  CassetteAdapter,
  serializeCassette,
  parseCassette,
} from './cassette.js'
export type {
  CassetteEntry,
  CassetteAdapterOptions,
  CassetteMeta,
  CassetteStdout,
  CassetteStdin,
  CassetteExit,
} from './cassette.js'
