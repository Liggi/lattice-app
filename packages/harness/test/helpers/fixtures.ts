/**
 * Real Claude CLI stream-json output samples.
 * Shapes taken from lattice-orchestrator mock fixtures.
 */

export const INIT_EVENT = {
  type: 'system',
  subtype: 'init',
  cwd: '/Users/test/project',
  session_id: 'abc-123',
  tools: ['Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write'],
  mcp_servers: [{ name: 'chrome-devtools', status: 'connected' }],
  model: 'claude-opus-4-20250514',
  permissionMode: 'default',
  apiKeySource: 'none',
}

export const SYSTEM_NON_INIT = {
  type: 'system',
  subtype: 'something_else',
  data: 'ignored',
}

/** Extended-thinking token counter the CLI emits every couple of tokens.
 *  Deliberately dropped by the normalizer — see IGNORED_SYSTEM_SUBTYPES. */
export const THINKING_TOKENS = {
  type: 'system',
  subtype: 'thinking_tokens',
  estimated_tokens: 89,
  estimated_tokens_delta: 2,
  uuid: '9c8f6d2e-1f3a-4b7c-9d0e-2a5b8c1d4e7f',
  session_id: 'abc-123',
}

export const TEXT_ASSISTANT = {
  type: 'assistant',
  message: {
    id: 'msg_001',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-20250514',
    content: [{ type: 'text', text: 'Hello, how can I help?' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 50,
    },
  },
  parent_tool_use_id: null,
  session_id: 'abc-123',
}

export const THINKING_ASSISTANT = {
  type: 'assistant',
  message: {
    id: 'msg_002',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-20250514',
    content: [
      { type: 'thinking', thinking: 'Let me think about this...' },
      { type: 'text', text: 'Here is my answer.' },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 200, output_tokens: 100 },
  },
  parent_tool_use_id: null,
  session_id: 'abc-123',
}

export const TOOL_USE_ASSISTANT = {
  type: 'assistant',
  message: {
    id: 'msg_003',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-20250514',
    content: [
      { type: 'text', text: "I'll read that file for you." },
      {
        type: 'tool_use',
        id: 'toolu_read_001',
        name: 'Read',
        input: { file_path: '/tmp/test.txt' },
      },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 200, output_tokens: 150 },
  },
  parent_tool_use_id: null,
  session_id: 'abc-123',
}

export const TOOL_RESULT_USER = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_read_001',
        content: 'File contents here',
      },
    ],
  },
  session_id: 'abc-123',
}

export const RESULT_SUCCESS = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 4236,
  duration_api_ms: 7564,
  num_turns: 1,
  result: 'Final response text',
  session_id: 'abc-123',
  total_cost_usd: 0.29,
  usage: {
    input_tokens: 250,
    output_tokens: 180,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 20626,
  },
}

export const RESULT_ERROR = {
  type: 'result',
  subtype: 'error',
  is_error: true,
  duration_ms: 100,
  result: 'Something went wrong',
  session_id: 'abc-123',
}

// Background task events (from real CLI cassette recording)
export const TASK_STARTED = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'be1rswj0x',
  tool_use_id: 'toolu_013LzW8nUUnXz34UWr7gNyFb',
  description: 'Run 5-step loop with 1s delays in background',
  task_type: 'local_bash',
  uuid: '1bf625af-8b86-45d0-adf2-cbb62abbd27c',
  session_id: 'abc-123',
}

export const TASK_UPDATED = {
  type: 'system',
  subtype: 'task_updated',
  task_id: 'be1rswj0x',
  patch: { status: 'completed', end_time: 1775924153771 },
  uuid: '65214d5c-fce5-41e4-8193-cdb8f11f7b88',
  session_id: 'abc-123',
}

export const TASK_NOTIFICATION = {
  type: 'system',
  subtype: 'task_notification',
  task_id: 'be1rswj0x',
  uuid: 'a1b2c3d4-notification',
  session_id: 'abc-123',
}

export const COMPACT_BOUNDARY = {
  type: 'system',
  subtype: 'compact_boundary',
  session_id: 'abc-123',
  uuid: 'compact-uuid-001',
  compact_metadata: { trigger: 'manual', pre_tokens: 161300 },
}

// Monitor events (CLI's background monitoring tool)
export const MONITOR_ASSISTANT = {
  type: 'assistant',
  message: {
    id: 'msg_monitor',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-20250514',
    content: [{
      type: 'tool_use',
      id: 'toolu_monitor_001',
      name: 'Monitor',
      input: {
        description: 'Build completion',
        timeout_ms: 900000,
        persistent: false,
        command: 'until [ -f /tmp/build-done ]; do sleep 5; done && cat /tmp/build.log',
      },
    }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 200, output_tokens: 100 },
  },
  parent_tool_use_id: null,
  session_id: 'abc-123',
}

export const MONITOR_TASK_STARTED = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'monitor-task-001',
  tool_use_id: 'toolu_monitor_001',
  description: 'Build completion',
  task_type: 'local_bash',
  uuid: 'monitor-uuid-001',
  session_id: 'abc-123',
}

export const MONITOR_RESULT = {
  type: 'user',
  message: {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'toolu_monitor_001',
      content: 'Monitor started (task monitor-task-001, timeout 900000ms). You will be notified on each event. Keep working — do not poll or sleep.',
    }],
  },
  session_id: 'abc-123',
}

// ScheduleWakeup events (CLI's /loop feature)
export const SCHEDULE_WAKEUP_ASSISTANT = {
  type: 'assistant',
  message: {
    id: 'msg_wakeup',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-20250514',
    content: [
      { type: 'text', text: "I'll check back in 2 minutes." },
      {
        type: 'tool_use',
        id: 'toolu_wakeup_001',
        name: 'ScheduleWakeup',
        input: {
          delaySeconds: 120,
          reason: 'Checking build progress',
          prompt: 'Check the build output at /tmp/build.log',
        },
      },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 200, output_tokens: 100 },
  },
  parent_tool_use_id: null,
  session_id: 'abc-123',
}

export const SCHEDULE_WAKEUP_RESULT = {
  type: 'user',
  message: {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'toolu_wakeup_001',
      content: 'Next wakeup scheduled for 20:27:00 (in 120s).',
    }],
  },
  session_id: 'abc-123',
}

// Convenience: JSON lines for a full session
export function fullSessionLines(): string[] {
  return [
    JSON.stringify(INIT_EVENT),
    JSON.stringify(TEXT_ASSISTANT),
    JSON.stringify(RESULT_SUCCESS),
  ]
}

export function toolSessionLines(): string[] {
  return [
    JSON.stringify(INIT_EVENT),
    JSON.stringify(TOOL_USE_ASSISTANT),
    JSON.stringify(TOOL_RESULT_USER),
    JSON.stringify(TEXT_ASSISTANT),
    JSON.stringify(RESULT_SUCCESS),
  ]
}
