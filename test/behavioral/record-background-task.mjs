#!/usr/bin/env node
/**
 * Records a cassette of a real Claude CLI session that uses run_in_background.
 *
 * The prompt asks Claude to run a command in the background and wait for it.
 * This captures the full lifecycle: Bash(run_in_background) → turn end →
 * (possible wake-up) → task completion.
 *
 * Usage: node test/behavioral/record-background-task.mjs
 * Output: test/behavioral/cassettes/background-task.jsonl
 */

import { spawn } from 'child_process'
import { writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outputDir = resolve(__dirname, 'cassettes')
const outputPath = resolve(outputDir, 'background-task.jsonl')

const claudeBin = process.env.CLAUDE_BIN || 'claude'

// Prompt designed to trigger run_in_background with a long-running command.
// 30 seconds is long enough that Claude should end its turn and use
// ScheduleWakeup or Monitor rather than busy-waiting.
const prompt = `Run this command in the background using run_in_background:true: bash -c 'for i in $(seq 1 30); do echo "tick $i of 30"; sleep 1; done; echo "ALL_DONE"'. It will take 30 seconds. Don't busy-wait — end your turn and come back when it's finished.`

console.log('Recording background task cassette...')
console.log(`Claude binary: ${claudeBin}`)
console.log(`Output: ${outputPath}`)

const entries = [JSON.stringify({ type: 'meta', ts: 0, format: 1 })]
const startTime = Date.now()

const child = spawn(claudeBin, [
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--verbose',
  '--model', 'sonnet',
], {
  cwd: '/tmp',
  env: {
    ...process.env,
    NODE_OPTIONS: '',
    VSCODE_INSPECTOR_OPTIONS: '',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

// Send initial prompt
const stdinMessage = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: prompt }
})
child.stdin.write(stdinMessage + '\n')

let buffer = ''
let turnCount = 0

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
      } else if (evt.type === 'assistant') {
        const content = evt.message?.content ?? []
        for (const block of content) {
          if (block.type === 'tool_use') {
            const inputSummary = block.name === 'Bash'
              ? `cmd=${(block.input?.command || '').toString().slice(0, 50)} bg=${block.input?.run_in_background}`
              : JSON.stringify(block.input || {}).slice(0, 80)
            console.log(`  [${ts}ms] tool_use: ${block.name} (${inputSummary})`)
          } else if (block.type === 'text') {
            console.log(`  [${ts}ms] text: ${block.text.slice(0, 100)}...`)
          } else if (block.type === 'thinking') {
            console.log(`  [${ts}ms] thinking: ${(block.thinking || '').slice(0, 80)}...`)
          }
        }
      } else if (evt.type === 'user') {
        const content = evt.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              const preview = typeof block.content === 'string'
                ? block.content.slice(0, 100)
                : JSON.stringify(block.content).slice(0, 100)
              console.log(`  [${ts}ms] tool_result for ${block.tool_use_id}: ${preview}`)
            }
          }
        }
      } else if (evt.type === 'result') {
        turnCount++
        console.log(`  [${ts}ms] >>> TURN ${turnCount} COMPLETE (subtype: ${evt.subtype || 'none'})`)

        // After enough turns, we have the full lifecycle
        if (turnCount >= 4) {
          console.log('\n  4 turns complete — ending recording in 2 seconds...')
          setTimeout(() => {
            child.kill('SIGTERM')
          }, 2000)
        }
      }
    } catch { /* ignore parse errors */ }
  }
})

child.stderr.on('data', (chunk) => {
  const text = chunk.toString()
  if (text.includes('error') || text.includes('Error')) {
    process.stderr.write(`  [stderr] ${text}`)
  }
})

child.on('close', (code, signal) => {
  const ts = Date.now() - startTime
  entries.push(JSON.stringify({ type: 'exit', ts, code: code ?? 0, signal: signal ?? undefined }))

  mkdirSync(outputDir, { recursive: true })
  writeFileSync(outputPath, entries.join('\n') + '\n')

  console.log(`\nRecorded ${entries.length} entries in ${ts}ms`)
  console.log(`Saved to: ${outputPath}`)

  // Summarize key events
  const bgBash = entries.filter(e => e.includes('run_in_background')).length
  const monitor = entries.filter(e => e.includes('Monitor')).length
  const taskOutput = entries.filter(e => e.includes('TaskOutput')).length
  const scheduleWakeup = entries.filter(e => e.includes('ScheduleWakeup')).length
  console.log(`\nKey event counts:`)
  console.log(`  run_in_background mentions: ${bgBash}`)
  console.log(`  Monitor tool calls: ${monitor}`)
  console.log(`  TaskOutput tool calls: ${taskOutput}`)
  console.log(`  ScheduleWakeup tool calls: ${scheduleWakeup}`)
  console.log(`  Turns completed: ${turnCount}`)
})

// Timeout after 3 minutes
setTimeout(() => {
  console.log('\nTimeout — killing claude process')
  child.kill('SIGTERM')
}, 180_000)
