#!/usr/bin/env npx tsx
/**
 * Record a cassette that captures mid-turn message injection.
 *
 * Spawns the CLI with a prompt that triggers multi-tool work, then injects
 * a second message to stdin while the first is still being processed.
 *
 * Output: test/cassettes/mid-turn-injection.jsonl
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CassetteRecorder, serializeCassette } from '../src/server/cassette.js'
import { ClaudeCliAdapter } from '../src/server/claude-cli-adapter.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CASSETTES_DIR = resolve(__dirname, '../test/cassettes')

// ---- Config ----

const INITIAL_PROMPT = 'I need a thorough audit of this codebase. Read every TypeScript file in src/server/ and src/protocol/ — for each file, tell me what it exports and how many lines it has. Do not skip any files. Use Glob to find them all first, then Read each one.'
const INJECTION_MESSAGE = 'Actually, skip the protocol directory — just focus on src/server/ files.'

// How many stdout events to wait before injecting. This ensures the CLI is
// mid-turn (executing tool calls) when the injection arrives. Set high enough
// that multiple tool calls are in flight.
const INJECT_AFTER_EVENTS = 8

// ---- Record ----

console.error('Recording mid-turn injection cassette')
console.error(`Initial prompt: ${INITIAL_PROMPT}`)
console.error(`Injection (after ${INJECT_AFTER_EVENTS} events): ${INJECTION_MESSAGE}`)
console.error('')

const adapter = new ClaudeCliAdapter()
const recorder = new CassetteRecorder(adapter)

const handle = await recorder.spawn({
  prompt: INITIAL_PROMPT,
  args: [
    '--mcp-config', '{"mcpServers":{}}',
    '--strict-mcp-config',
    '--allowedTools', 'Read,Grep,Glob',
    '--dangerously-skip-permissions',
  ],
})

let eventCount = 0
let injected = false

for await (const line of handle.stdout) {
  eventCount++

  try {
    const event = JSON.parse(line)
    const preview = event.type === 'assistant'
      ? `assistant: ${JSON.stringify(event.message?.content?.[0]?.type ?? '...')}`
      : event.type === 'result'
        ? `result: stop_reason=${event.result?.stop_reason ?? '?'}`
        : `${event.type}${event.subtype ? `:${event.subtype}` : ''}`
    console.error(`  [${eventCount}] ${preview}`)
  } catch {
    console.error(`  [${eventCount}] ${line.substring(0, 100)}`)
  }

  // Inject mid-turn message after enough events have flowed
  if (!injected && eventCount >= INJECT_AFTER_EVENTS) {
    injected = true
    console.error('')
    console.error(`  >>> INJECTING: "${INJECTION_MESSAGE}"`)
    console.error('')
    // The CLI expects JSON user messages on stdin in --print mode
    handle.write(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: INJECTION_MESSAGE },
      session_id: '',
      parent_tool_use_id: null,
    }) + '\n')
  }
}

const { code } = await handle.exited
console.error('')
console.error(`CLI exited with code ${code}`)

// ---- Save ----

const recording = recorder.getRecording()
const serialized = serializeCassette(recording)

mkdirSync(CASSETTES_DIR, { recursive: true })
const outPath = resolve(CASSETTES_DIR, 'mid-turn-injection.jsonl')
writeFileSync(outPath, serialized)

const stats = {
  total: recording.length,
  stdout: recording.filter(e => e.type === 'stdout').length,
  stdin: recording.filter(e => e.type === 'stdin').length,
  exit: recording.filter(e => e.type === 'exit').length,
  durationMs: recording[recording.length - 1]?.ts ?? 0,
}

console.error(`Saved ${stats.total} entries to ${outPath}`)
console.error(`  stdout: ${stats.stdout}, stdin: ${stats.stdin}, exit: ${stats.exit}`)
console.error(`  duration: ${stats.durationMs}ms`)
