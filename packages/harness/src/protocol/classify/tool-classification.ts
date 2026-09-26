export type ToolCategory =
  | 'read'
  | 'search'
  | 'write'
  | 'execute'
  | 'agent'
  | 'meta'
  | 'integration'

export interface ToolClassification {
  name: string
  category: ToolCategory
  summary: { present: string; past: string }
  detail?: string
  isCollapsible: boolean
  isStructural: boolean
  mcpServer?: string
}

// ---- Internal types ----

interface ToolDef {
  category: ToolCategory
  summary: { present: string; past: string }
  extractDetail?: (input: Record<string, unknown>) => string | undefined
  isCollapsible: boolean
  isStructural: boolean
}

// ---- Helpers ----

function truncate(s: string, max = 80): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key]
  return typeof v === 'string' ? v : undefined
}

// ---- Tool registry ----

const TOOLS: Record<string, ToolDef> = {
  // Read (collapsible)
  Read: {
    category: 'read',
    summary: { present: 'Reading file', past: 'Read file' },
    extractDetail: (input) => str(input, 'file_path'),
    isCollapsible: true,
    isStructural: false,
  },
  Glob: {
    category: 'read',
    summary: { present: 'Searching files', past: 'Searched files' },
    extractDetail: (input) => str(input, 'pattern'),
    isCollapsible: true,
    isStructural: false,
  },
  LS: {
    category: 'read',
    summary: { present: 'Listing directory', past: 'Listed directory' },
    extractDetail: (input) => str(input, 'path'),
    isCollapsible: true,
    isStructural: false,
  },
  ListMcpResourcesTool: {
    category: 'read',
    summary: { present: 'Listing resources', past: 'Listed resources' },
    isCollapsible: true,
    isStructural: false,
  },
  ReadMcpResourceTool: {
    category: 'read',
    summary: { present: 'Reading resource', past: 'Read resource' },
    extractDetail: (input) => str(input, 'uri'),
    isCollapsible: true,
    isStructural: false,
  },

  // Search (collapsible)
  Grep: {
    category: 'search',
    summary: { present: 'Searching code', past: 'Searched code' },
    extractDetail: (input) => str(input, 'pattern'),
    isCollapsible: true,
    isStructural: false,
  },
  WebSearch: {
    category: 'search',
    summary: { present: 'Searching web', past: 'Searched web' },
    extractDetail: (input) => str(input, 'query'),
    isCollapsible: true,
    isStructural: false,
  },
  WebFetch: {
    category: 'search',
    summary: { present: 'Fetching page', past: 'Fetched page' },
    extractDetail: (input) => str(input, 'url'),
    isCollapsible: true,
    isStructural: false,
  },
  ToolSearch: {
    category: 'search',
    summary: { present: 'Searching tools', past: 'Searched tools' },
    extractDetail: (input) => str(input, 'query'),
    isCollapsible: true,
    isStructural: false,
  },

  // Write (never collapsed)
  Write: {
    category: 'write',
    summary: { present: 'Writing file', past: 'Wrote file' },
    extractDetail: (input) => str(input, 'file_path'),
    isCollapsible: false,
    isStructural: false,
  },
  Edit: {
    category: 'write',
    summary: { present: 'Editing file', past: 'Edited file' },
    extractDetail: (input) => str(input, 'file_path'),
    isCollapsible: false,
    isStructural: false,
  },
  MultiEdit: {
    category: 'write',
    summary: { present: 'Editing file', past: 'Edited file' },
    extractDetail: (input) => str(input, 'file_path'),
    isCollapsible: false,
    isStructural: false,
  },
  NotebookEdit: {
    category: 'write',
    summary: { present: 'Editing notebook', past: 'Edited notebook' },
    extractDetail: (input) => str(input, 'notebook_path'),
    isCollapsible: false,
    isStructural: false,
  },

  // Execute (never collapsed)
  Bash: {
    category: 'execute',
    summary: { present: 'Running command', past: 'Ran command' },
    extractDetail: (input) => {
      const cmd = str(input, 'command')
      return cmd ? truncate(cmd, 60) : undefined
    },
    isCollapsible: false,
    isStructural: false,
  },
  Monitor: {
    category: 'execute',
    summary: { present: 'Monitoring', past: 'Monitored' },
    extractDetail: (input) => str(input, 'description'),
    isCollapsible: true,
    isStructural: false,
  },
  ScheduleWakeup: {
    category: 'meta',
    summary: { present: 'Scheduling wakeup', past: 'Scheduled wakeup' },
    extractDetail: (input) => str(input, 'reason'),
    isCollapsible: true,
    isStructural: false,
  },

  // Agent (structural, never collapsed)
  Agent: {
    category: 'agent',
    summary: { present: 'Spawning agent', past: 'Spawned agent' },
    extractDetail: (input) => str(input, 'description') ?? str(input, 'subagent_type'),
    isCollapsible: false,
    isStructural: true,
  },
  SendMessage: {
    category: 'agent',
    summary: { present: 'Sending message', past: 'Sent message' },
    extractDetail: (input) => str(input, 'to'),
    isCollapsible: false,
    isStructural: true,
  },
  EnterWorktree: {
    category: 'agent',
    summary: { present: 'Entering worktree', past: 'Entered worktree' },
    isCollapsible: false,
    isStructural: true,
  },
  ExitWorktree: {
    category: 'agent',
    summary: { present: 'Exiting worktree', past: 'Exited worktree' },
    isCollapsible: false,
    isStructural: true,
  },

  // Meta (interactive, never collapsed)
  AskUserQuestion: {
    category: 'meta',
    summary: { present: 'Asking user', past: 'Asked user' },
    extractDetail: (input) => {
      const q = str(input, 'question')
      return q ? truncate(q, 60) : undefined
    },
    isCollapsible: false,
    isStructural: false,
  },
  EnterPlanMode: {
    category: 'meta',
    summary: { present: 'Entering plan mode', past: 'Entered plan mode' },
    isCollapsible: false,
    isStructural: false,
  },
  ExitPlanMode: {
    category: 'meta',
    summary: { present: 'Exiting plan mode', past: 'Exited plan mode' },
    isCollapsible: false,
    isStructural: false,
  },
  TaskCreate: {
    category: 'meta',
    summary: { present: 'Creating task', past: 'Created task' },
    extractDetail: (input) => str(input, 'subject') ?? str(input, 'description'),
    isCollapsible: false,
    isStructural: false,
  },
  TaskUpdate: {
    category: 'meta',
    summary: { present: 'Updating task', past: 'Updated task' },
    extractDetail: (input) => str(input, 'id'),
    isCollapsible: false,
    isStructural: false,
  },
  TaskGet: {
    category: 'meta',
    summary: { present: 'Checking task', past: 'Checked task' },
    extractDetail: (input) => str(input, 'id'),
    isCollapsible: false,
    isStructural: false,
  },
  TaskList: {
    category: 'meta',
    summary: { present: 'Listing tasks', past: 'Listed tasks' },
    isCollapsible: false,
    isStructural: false,
  },
  TaskOutput: {
    category: 'meta',
    summary: { present: 'Reading task output', past: 'Read task output' },
    extractDetail: (input) => str(input, 'id'),
    isCollapsible: false,
    isStructural: false,
  },
  TaskStop: {
    category: 'meta',
    summary: { present: 'Stopping task', past: 'Stopped task' },
    extractDetail: (input) => str(input, 'id'),
    isCollapsible: false,
    isStructural: false,
  },
}

// ---- Classification ----

export function classifyTool(name: string, input?: unknown): ToolClassification {
  if (name.startsWith('mcp__')) {
    return classifyMcpTool(name)
  }

  const def = TOOLS[name]
  if (!def) {
    return {
      name,
      category: 'meta',
      summary: { present: `Using ${name}`, past: `Used ${name}` },
      isCollapsible: false,
      isStructural: false,
    }
  }

  const safeInput =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}

  return {
    name,
    category: def.category,
    summary: def.summary,
    detail: def.extractDetail?.(safeInput),
    isCollapsible: def.isCollapsible,
    isStructural: def.isStructural,
  }
}

function classifyMcpTool(name: string): ToolClassification {
  // mcp__servername__toolname
  const parts = name.split('__')
  const server = parts[1] ?? 'unknown'
  const toolName = parts.slice(2).join('__') || name

  return {
    name,
    category: 'integration',
    summary: {
      present: `${server}: ${toolName}`,
      past: `${server}: ${toolName}`,
    },
    isCollapsible: false,
    isStructural: false,
    mcpServer: server,
  }
}
