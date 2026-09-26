#!/usr/bin/env node
/**
 * Agent Stub — emulates Claude CLI's `--output-format stream-json` protocol.
 *
 * The daemon spawns this instead of the real `claude` binary during behavioral
 * tests. It reads a scenario file (via AGENT_STUB_SCENARIO env var or a default),
 * emits events on stdout as newline-delimited JSON, reads stdin for injected
 * messages, and exits cleanly on SIGTERM.
 *
 * Accepts the same CLI args as Claude CLI (ignores most — just parses what it
 * needs to behave correctly).
 */

import { createInterface } from 'readline'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// ---------------------------------------------------------------------------
// CLI arg parsing (minimal — just what the stub needs)
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)

function getArg(flag) {
  const idx = args.indexOf(flag)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined
}

const rawResumeId = getArg('--resume')
// Real Claude CLI ignores --resume if the session doesn't exist. Simulate this
// by treating placeholder IDs (pending-*, seed-*) as non-resumable — they don't
// correspond to real sessions the stub previously created.
const resumeSessionId = rawResumeId && !rawResumeId.startsWith('pending-')
  ? rawResumeId
  : undefined
const model = getArg('--model') ?? 'claude-sonnet-4-5-20250929'
const sessionId = resumeSessionId ?? `stub-session-${Date.now()}`

// ---------------------------------------------------------------------------
// Scenario loading
// ---------------------------------------------------------------------------

const scenarioPath = process.env.AGENT_STUB_SCENARIO
  ? resolve(process.env.AGENT_STUB_SCENARIO)
  : resolve(new URL('../scenarios/simple-response.json', import.meta.url).pathname)

let scenario
try {
  scenario = JSON.parse(readFileSync(scenarioPath, 'utf-8'))
} catch (err) {
  process.stderr.write(`[agent-stub] Failed to load scenario: ${scenarioPath}: ${err.message}\n`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function emit(event) {
  try {
    process.stdout.write(JSON.stringify(event) + '\n')
  } catch {
    // EPIPE — reader closed. Ignore.
  }
}

// Why setImmediate instead of setTimeout?
// When the daemon spawns this stub a second time in quick succession
// (~400ms after the previous stub exited), the libuv timer phase in the
// child becomes wedged: setTimeout/setInterval callbacks never fire,
// while nextTick and setImmediate continue to work normally. Reproduced
// 10/10 with daemon-mediated spawn; never reproduces with direct spawn,
// so the trigger is in the daemon's spawn path interacting with libuv.
// We poll via setImmediate (proven-working scheduler) to make the stub
// robust against this without depending on a workaround in the daemon.
async function sleep(ms) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    await new Promise(r => setImmediate(r))
  }
}

// ---------------------------------------------------------------------------
// Event builders — produce stream-json events matching Claude CLI output
// ---------------------------------------------------------------------------

let msgCounter = 0

function buildSystemInit() {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd: process.cwd(),
    tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    mcp_servers: [],
    model,
    permissionMode: 'bypassPermissions',
  }
}

function buildAssistantMessage(content, stopReason = 'end_turn') {
  msgCounter++
  return {
    type: 'assistant',
    session_id: sessionId,
    message: {
      id: `msg_stub_${msgCounter}`,
      type: 'message',
      role: 'assistant',
      model,
      content: Array.isArray(content) ? content : [{ type: 'text', text: content }],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: 100 + msgCounter * 50,
        output_tokens: 20 + msgCounter * 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }
}

function buildResult(durationMs = 1000) {
  return {
    type: 'result',
    session_id: sessionId,
    subtype: 'success',
    is_error: false,
    duration_ms: durationMs,
    duration_api_ms: Math.round(durationMs * 0.85),
    num_turns: 1,
    result: '',
    usage: {
      input_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 100,
      output_tokens: 80,
      server_tool_use: { web_search_requests: 0 },
    },
  }
}

// ---------------------------------------------------------------------------
// Scenario event expansion
//
// Scenario events are compact shorthand. Expand them to full stream-json.
// ---------------------------------------------------------------------------

function expandEvent(evt) {
  switch (evt.type) {
    case 'system_init':
      return buildSystemInit()

    case 'assistant': {
      const hasToolUse = Array.isArray(evt.content) &&
        evt.content.some(b => b.type === 'tool_use')
      return buildAssistantMessage(evt.content, hasToolUse ? 'tool_use' : 'end_turn')
    }

    case 'result':
      return buildResult(evt.duration_ms ?? 1000)

    case 'raw':
      // Pass through a raw event verbatim (for edge case testing)
      return { session_id: sessionId, ...evt.event }

    default:
      process.stderr.write(`[agent-stub] Unknown event type: ${evt.type}\n`)
      return null
  }
}

// ---------------------------------------------------------------------------
// Play a sequence of scenario events
// ---------------------------------------------------------------------------

async function playSequence(events) {
  for (const evt of events) {
    if (evt.delay) await sleep(evt.delay)
    const expanded = expandEvent(evt)
    if (expanded) emit(expanded)
  }
}

// ---------------------------------------------------------------------------
// Stdin handling — reads stream-json messages from the daemon
// ---------------------------------------------------------------------------

// The first stdin message is the initial prompt. The main `events` sequence is
// already the response to that prompt, so we consume it silently. Only
// subsequent stdin messages trigger `on_stdin` responses.
let stdinMessageCount = 0
let stdinResponseIndex = 0
let mainSequenceDone = false
const pendingStdinMessages = []

async function handleStdinMessage(msg) {
  // Check for scenario-defined stdin responses
  const responses = scenario.on_stdin?.responses ?? scenario.on_stdin?.respond_with
  if (responses && stdinResponseIndex < responses.length) {
    const responseSeq = responses[stdinResponseIndex]
    stdinResponseIndex++
    await playSequence(Array.isArray(responseSeq) ? responseSeq : [responseSeq])
  } else if (scenario.on_stdin?.echo) {
    // Default behavior: echo back a simple acknowledgment
    emit(buildAssistantMessage(`Acknowledged: ${JSON.stringify(msg.message?.content ?? '').slice(0, 50)}`))
    emit(buildResult(200))
  }
}

function setupStdin() {
  const rl = createInterface({ input: process.stdin })

  rl.on('line', async (line) => {
    if (!line.trim()) return

    // Strict mode: validate stream-json format, just like real Claude CLI.
    // Malformed stdin is silently ignored (Claude's actual behavior).
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      process.stderr.write(`[agent-stub] REJECTED stdin (not JSON): ${line.slice(0, 80)}\n`)
      return
    }

    // stream-json requires: { type: "user", message: { role: "user", content: ... } }
    if (!msg.type || !msg.message || msg.message.role !== 'user') {
      process.stderr.write(`[agent-stub] REJECTED stdin (bad schema): type=${msg.type}, role=${msg.message?.role}\n`)
      return
    }

    stdinMessageCount++
    process.stderr.write(`[agent-stub] Received stdin #${stdinMessageCount}: type=${msg.type}\n`)

    if (stdinMessageCount === 1) {
      // First message is the initial prompt — main events handle the response.
      return
    }

    // Subsequent messages: if main sequence is still playing, queue them.
    // Otherwise handle immediately.
    if (!mainSequenceDone) {
      pendingStdinMessages.push(msg)
    } else {
      await handleStdinMessage(msg)
    }
  })

  rl.on('close', () => {
    process.stderr.write('[agent-stub] stdin closed\n')
  })
}

// ---------------------------------------------------------------------------
// Signal handling
// ---------------------------------------------------------------------------

process.on('SIGTERM', () => {
  process.stderr.write('[agent-stub] Received SIGTERM, exiting\n')
  process.exit(0)
})

process.on('SIGINT', () => {
  process.stderr.write('[agent-stub] Received SIGINT\n')
  // Claude CLI handles SIGINT as interrupt (cancel current turn), not exit.
  // Real Claude takes non-trivial time to wrap up (save state, flush output).
  // Delay the result to make the stopping state observable.
  // Uses sleep() (setImmediate-based) — see comment on sleep() above.
  void sleep(1500).then(() => emit(buildResult(0)))
})

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  process.stderr.write(`[agent-stub] Started with session_id=${sessionId}, resume=${resumeSessionId ?? 'none'}, scenario=${scenarioPath}\n`)

  // Simulate slow CLI startup (boot time before first output)
  if (scenario.startup_delay) {
    process.stderr.write(`[agent-stub] startup_delay: ${scenario.startup_delay}ms\n`)
    await sleep(scenario.startup_delay)
  }

  setupStdin()

  // If resumed and scenario provides resume_events, use those instead of events.
  // This lets tests distinguish "fresh start" from "resumed with context".
  const mainEvents = (resumeSessionId && scenario.resume_events)
    ? scenario.resume_events
    : scenario.events

  // Play the main event sequence (response to the initial prompt)
  await playSequence(mainEvents)
  mainSequenceDone = true

  // Drain any stdin messages that arrived while the main sequence was playing
  for (const msg of pendingStdinMessages) {
    await handleStdinMessage(msg)
  }
  pendingStdinMessages.length = 0

  // Exit immediately if scenario says so (simulates idle timeout / process death)
  if (scenario.exit_after_main) {
    const code = scenario.exit_code ?? 0
    process.stderr.write(`[agent-stub] exit_after_main: exiting with code ${code}\n`)
    process.exit(code)
    return
  }

  // Process stays alive (like Claude's keep-alive) waiting for stdin or SIGTERM.
  process.stderr.write('[agent-stub] Main sequence complete, waiting for stdin or SIGTERM\n')
}

main().catch((err) => {
  process.stderr.write(`[agent-stub] Fatal: ${err.message}\n`)
  process.exit(1)
})
