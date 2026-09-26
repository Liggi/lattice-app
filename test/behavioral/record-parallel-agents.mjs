#!/usr/bin/env node
/**
 * Records a cassette of a real Claude CLI session that produces parallel Agent calls.
 *
 * Usage: node test/behavioral/record-parallel-agents.mjs
 * Output: test/behavioral/cassettes/parallel-agents.jsonl
 */

import { spawn } from 'child_process'
import { writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outputDir = resolve(__dirname, 'cassettes')
const outputPath = resolve(outputDir, 'parallel-agents.jsonl')

// Find claude binary
const claudeBin = process.env.CLAUDE_BIN || 'claude'

// Prompt designed to trigger parallel Agent tool calls
const prompt = `Search these three directories in parallel using Agent tools (subagent_type: Explore). Launch all three agents simultaneously in a single message:
1. ~/src/agent-ui-harness/src/protocol/ — list the exported functions
2. ~/src/agent-ui-harness/src/server/ — list the exported functions
3. ~/src/agent-ui-harness/src/client/ — list the exported functions

Use three parallel Agent calls. Keep each agent's prompt short (under 50 words). After all three return, write a one-sentence summary.`

console.log('Recording parallel agents cassette...')
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
    // Strip vars that interfere with nested Claude
    NODE_OPTIONS: '',
    VSCODE_INSPECTOR_OPTIONS: '',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

// Send initial prompt via stdin (stream-json format)
const stdinMessage = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: prompt }
})
child.stdin.write(stdinMessage + '\n')

let buffer = ''

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString()
  const lines = buffer.split('\n')
  buffer = lines.pop() // Keep incomplete line

  for (const line of lines) {
    if (!line.trim()) continue
    const ts = Date.now() - startTime
    entries.push(JSON.stringify({ type: 'stdout', ts, data: line }))

    // Log progress
    try {
      const evt = JSON.parse(line)
      if (evt.type === 'system' && evt.subtype === 'init') {
        console.log(`  [${ts}ms] system init (session: ${evt.session_id})`)
      } else if (evt.type === 'assistant') {
        const content = evt.message?.content ?? []
        for (const block of content) {
          if (block.type === 'tool_use' && block.name === 'Agent') {
            console.log(`  [${ts}ms] Agent tool_use: ${block.input?.description ?? '?'}`)
          } else if (block.type === 'text') {
            console.log(`  [${ts}ms] text: ${block.text.slice(0, 60)}...`)
          }
        }
      } else if (evt.type === 'result') {
        console.log(`  [${ts}ms] turn complete`)
      }
    } catch { /* ignore parse errors */ }
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

  // Check if we got parallel agents
  const agentCount = entries.filter(e => e.includes('"Agent"') && e.includes('tool_use')).length
  console.log(`Agent tool_use events: ${agentCount}`)
  if (agentCount < 2) {
    console.warn('WARNING: Less than 2 Agent calls — may need to re-record with a different prompt')
  }
})

// Timeout after 2 minutes
setTimeout(() => {
  console.log('\nTimeout — killing claude process')
  child.kill('SIGTERM')
}, 120_000)
