#!/usr/bin/env node
/**
 * Records a cassette of a Claude CLI session that emits a `post_turn_summary`
 * system event (the "recap" event — background per-turn summarizer output).
 *
 * The schema for the event lives in claude-code source at
 *   src/entrypoints/sdk/coreSchemas.ts :: SDKPostTurnSummaryMessageSchema
 * and is described as "Background post-turn summary emitted after each
 * assistant turn." In `stream-json --verbose` mode the CLI writes it
 * unconditionally (cli/print.ts:884), so any normal turn should produce one.
 *
 * Usage: node test/behavioral/record-post-turn-summary.mjs
 * Output: test/behavioral/cassettes/post-turn-summary.jsonl
 */

import { spawn } from 'child_process'
import { writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outputDir = resolve(__dirname, 'cassettes')
const outputPath = resolve(outputDir, 'post-turn-summary.jsonl')

const claudeBin = process.env.CLAUDE_BIN || 'claude'

// Prompt designed to produce a clear, non-trivial assistant turn so the
// background summarizer has something concrete to recap. Kept short so the
// recording finishes quickly.
const prompt = `In one short paragraph (3-4 sentences), describe what a "cassette" is in the context of behavioral testing. Do not use any tools.`

console.log('Recording post_turn_summary cassette...')
console.log(`Claude binary: ${claudeBin}`)
console.log(`Output: ${outputPath}`)

const entries = [JSON.stringify({ type: 'meta', ts: 0, format: 1 })]
const startTime = Date.now()

const child = spawn(claudeBin, [
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--verbose',
  '--dangerously-skip-permissions',
  '--model', 'sonnet',
], {
  cwd: process.env.HOME + '/src',
  env: {
    ...process.env,
    NODE_OPTIONS: '',
    VSCODE_INSPECTOR_OPTIONS: '',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

const stdinMessage = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: prompt }
})
child.stdin.write(stdinMessage + '\n')

let buffer = ''
let sawSummary = false
let resultTs = null

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString()
  const lines = buffer.split('\n')
  buffer = lines.pop()

  for (const line of lines) {
    if (!line.trim()) continue
    const ts = Date.now() - startTime
    entries.push(JSON.stringify({ type: 'stdout', ts, data: line }))

    try {
      const evt = JSON.parse(line)
      if (evt.type === 'system' && evt.subtype === 'init') {
        console.log(`  [${ts}ms] system init (session: ${evt.session_id})`)
      } else if (evt.type === 'system' && evt.subtype === 'post_turn_summary') {
        sawSummary = true
        console.log(`  [${ts}ms] *** post_turn_summary ***`)
        console.log(`    title: ${evt.title}`)
        console.log(`    status: ${evt.status_category} — ${evt.status_detail}`)
        console.log(`    is_noteworthy: ${evt.is_noteworthy}`)
      } else if (evt.type === 'system') {
        console.log(`  [${ts}ms] system: ${evt.subtype}`)
      } else if (evt.type === 'assistant') {
        const blocks = evt.message?.content ?? []
        for (const b of blocks) {
          if (b.type === 'text') console.log(`  [${ts}ms] text: ${b.text.slice(0, 80)}...`)
        }
      } else if (evt.type === 'result') {
        resultTs = ts
        console.log(`  [${ts}ms] result (turn end) — waiting up to 15s for trailing post_turn_summary...`)
      }
    } catch { /* ignore */ }
  }
})

child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk)
})

child.on('close', (code, signal) => {
  const ts = Date.now() - startTime
  entries.push(JSON.stringify({ type: 'exit', ts, code: code ?? 0, signal: signal ?? undefined }))

  mkdirSync(outputDir, { recursive: true })
  writeFileSync(outputPath, entries.join('\n') + '\n')

  console.log(`\nRecorded ${entries.length} entries in ${ts}ms`)
  console.log(`Saved to: ${outputPath}`)
  console.log(`post_turn_summary captured: ${sawSummary ? 'YES' : 'NO'}`)
  if (!sawSummary) {
    console.warn('WARNING: no post_turn_summary observed — the summarizer may be opt-in or post-result.')
  }
  process.exit(sawSummary ? 0 : 2)
})

// Give the CLI time to emit the post-turn summarizer output (it fires after
// the assistant turn but may be slightly after the `result` event).
let resultWatchdog = null
const checkExit = setInterval(() => {
  if (resultTs !== null && resultWatchdog === null) {
    resultWatchdog = setTimeout(() => {
      console.log('  Closing stdin to end session...')
      child.stdin.end()
      // If still alive after another 5s, kill it
      setTimeout(() => {
        if (!child.killed) child.kill('SIGTERM')
      }, 5000)
    }, 15_000)
  }
}, 500)

setTimeout(() => {
  console.log('\nGlobal timeout (90s) — killing claude process')
  clearInterval(checkExit)
  child.kill('SIGTERM')
}, 90_000)
