#!/usr/bin/env npx tsx
/**
 * Record a real Claude CLI session as a cassette fixture.
 *
 * Usage:
 *   npx tsx scripts/record-cassette.ts <name> "<prompt>"
 *
 * Examples:
 *   npx tsx scripts/record-cassette.ts simple-response "Say hello in one sentence."
 *   npx tsx scripts/record-cassette.ts tool-use "Read the file package.json and tell me the package name."
 *   npx tsx scripts/record-cassette.ts extended-thinking "What are the first 10 prime numbers? Think step by step."
 *
 * Output: test/cassettes/<name>.jsonl
 *
 * Requires: Claude CLI installed and authenticated.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CassetteRecorder, serializeCassette } from '../src/server/cassette.js'
import { ClaudeCliAdapter } from '../src/server/claude-cli-adapter.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CASSETTES_DIR = resolve(__dirname, '../test/cassettes')

// ---- Parse args ----

const name = process.argv[2]
const prompt = process.argv[3]
const extraArgs = process.argv.slice(4) // Additional CLI flags passed after the prompt

if (!name || !prompt) {
  console.error('Usage: npx tsx scripts/record-cassette.ts <name> "<prompt>" [extra-cli-flags...]')
  console.error('')
  console.error('Examples:')
  console.error('  npx tsx scripts/record-cassette.ts simple-response "Say hello in one sentence."')
  console.error('  npx tsx scripts/record-cassette.ts tool-use "Read package.json and tell me the package name." --allowedTools "Read"')
  process.exit(1)
}

// ---- Record ----

console.error(`Recording cassette: ${name}`)
console.error(`Prompt: ${prompt}`)
console.error('')

const adapter = new ClaudeCliAdapter()
const recorder = new CassetteRecorder(adapter)

const handle = await recorder.spawn({
  prompt,
  args: [
    // Skip MCP servers for clean, environment-independent recordings.
    // --strict-mcp-config is a boolean flag (only use servers from --mcp-config).
    // --mcp-config with an empty object means: zero MCP servers.
    '--mcp-config', '{"mcpServers":{}}',
    '--strict-mcp-config',
    ...extraArgs,
  ],
})

// Consume stdout, logging a summary of each event
for await (const line of handle.stdout) {
  try {
    const event = JSON.parse(line)
    const preview = event.type === 'assistant'
      ? `assistant: ${JSON.stringify(event.message?.content?.[0]?.text?.substring(0, 80) ?? '...')}`
      : event.type === 'result'
        ? `result: stop_reason=${event.result?.stop_reason ?? '?'}`
        : `${event.type}${event.subtype ? `:${event.subtype}` : ''}`
    console.error(`  [${event.type}] ${preview}`)
  } catch {
    console.error(`  [raw] ${line.substring(0, 100)}`)
  }
}

const { code } = await handle.exited
console.error('')
console.error(`CLI exited with code ${code}`)

// ---- Save ----

const recording = recorder.getRecording()
const serialized = serializeCassette(recording)

mkdirSync(CASSETTES_DIR, { recursive: true })
const outPath = resolve(CASSETTES_DIR, `${name}.jsonl`)
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
