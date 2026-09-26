#!/usr/bin/env node
/**
 * Mock Claude CLI that emits stream-json events.
 * Supports: init → thinking → text → tool_use → tool_result → text → result
 * Also reads stdin for follow-up input.
 */

import { createInterface } from 'node:readline'

const sessionId = 'mock-session-' + Date.now()

const events = [
  {
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: sessionId,
    tools: ['Read', 'Write', 'Bash'],
    model: 'claude-opus-4-20250514',
    permissionMode: 'default',
  },
  {
    type: 'assistant',
    message: {
      id: 'msg_001',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-20250514',
      content: [{ type: 'thinking', thinking: 'Let me analyze this request...' }],
      stop_reason: null,
      usage: { input_tokens: 100, output_tokens: 20 },
    },
    session_id: sessionId,
  },
  {
    type: 'assistant',
    message: {
      id: 'msg_002',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-20250514',
      content: [
        { type: 'text', text: "I'll read the file for you." },
        { type: 'tool_use', id: 'toolu_001', name: 'Read', input: { file_path: '/tmp/test.txt' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    session_id: sessionId,
  },
  {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_001', content: 'Hello from the file!' },
      ],
    },
    session_id: sessionId,
  },
  {
    type: 'assistant',
    message: {
      id: 'msg_003',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-20250514',
      content: [{ type: 'text', text: 'The file contains: "Hello from the file!"' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 150, output_tokens: 30 },
    },
    session_id: sessionId,
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 2500,
    num_turns: 1,
    result: 'The file contains: "Hello from the file!"',
    session_id: sessionId,
    usage: { input_tokens: 250, output_tokens: 100 },
  },
]

// Emit events with small delays to simulate real CLI
let i = 0
function emitNext() {
  if (i < events.length) {
    console.log(JSON.stringify(events[i]))
    i++
    setTimeout(emitNext, 10)
  } else {
    // Listen for stdin (follow-up messages)
    const rl = createInterface({ input: process.stdin })
    rl.on('line', (line) => {
      // Echo back a simple response
      console.log(JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_follow',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-20250514',
          content: [{ type: 'text', text: `You said: ${line}` }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 50, output_tokens: 20 },
        },
        session_id: sessionId,
      }))
      console.log(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 100,
        session_id: sessionId,
        usage: { input_tokens: 50, output_tokens: 20 },
      }))
    })
  }
}

emitNext()
