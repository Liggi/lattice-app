#!/usr/bin/env node
/**
 * Records a cassette of a real Claude CLI session that enters plan mode.
 *
 * The prompt asks Claude to plan before acting, which should trigger
 * EnterPlanMode → plan content → exit_plan_mode (pending approval).
 *
 * Usage: node test/behavioral/record-plan-mode.mjs
 * Output: test/behavioral/cassettes/plan-mode.jsonl
 */

import { spawn } from 'child_process'
import { writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outputDir = resolve(__dirname, 'cassettes')
const outputPath = resolve(outputDir, 'plan-mode.jsonl')

const claudeBin = process.env.CLAUDE_BIN || 'claude'

// Prompt designed to trigger plan mode — ask for a multi-step task that
// benefits from planning. Use a small, safe, read-only task.
const prompt = `I want you to enter plan mode and create a plan for how you would refactor the file at ~/src/agent-ui-toolkit/src/tokens.ts to split the accent colors into a separate file. Don't execute anything — just make the plan and wait for my approval.`

console.log('Recording plan mode cassette...')
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
  cwd: process.env.HOME + '/src',
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
let sawPlanPending = false

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
            console.log(`  [${ts}ms] tool_use: ${block.name} ${block.id}`)
            if (block.name === 'EnterPlanMode') {
              console.log(`  >>> PLAN MODE ENTERED`)
            }
            if (block.name === 'exit_plan_mode' || block.name === 'ExitPlanMode') {
              console.log(`  >>> PLAN SUBMITTED (waiting for approval)`)
            }
          } else if (block.type === 'text') {
            console.log(`  [${ts}ms] text: ${block.text.slice(0, 80)}...`)
          }
        }
      } else if (evt.type === 'user') {
        // Tool result — check if plan is pending
        const content = evt.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              console.log(`  [${ts}ms] tool_result for ${block.tool_use_id}`)
            }
          }
        }
      } else if (evt.type === 'result') {
        console.log(`  [${ts}ms] turn complete (subtype: ${evt.subtype || 'none'})`)
        // If we see a result with subtype 'pending' or the turn ended waiting for input,
        // the plan is pending approval
        if (!sawPlanPending) {
          sawPlanPending = true
          console.log('\n  Plan is pending. Sending approval in 2 seconds...')
          setTimeout(() => {
            const approvalMsg = JSON.stringify({
              type: 'user',
              message: { role: 'user', content: 'Approved. Proceed with the plan.' }
            })
            const approvalTs = Date.now() - startTime
            entries.push(JSON.stringify({ type: 'stdin', ts: approvalTs, data: approvalMsg + '\n' }))
            child.stdin.write(approvalMsg + '\n')
            console.log(`  [${approvalTs}ms] >>> APPROVAL SENT`)
          }, 2000)
        }
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

  // Check for plan mode events
  const planEnter = entries.filter(e => e.includes('EnterPlanMode')).length
  const planExit = entries.filter(e => e.includes('exit_plan_mode') || e.includes('ExitPlanMode')).length
  console.log(`EnterPlanMode events: ${planEnter}`)
  console.log(`exit_plan_mode/ExitPlanMode events: ${planExit}`)
  if (planEnter === 0) {
    console.warn('WARNING: No EnterPlanMode seen — Claude may not have used plan mode')
  }
})

// Timeout after 3 minutes (plan mode can be slow)
setTimeout(() => {
  console.log('\nTimeout — killing claude process')
  child.kill('SIGTERM')
}, 180_000)
