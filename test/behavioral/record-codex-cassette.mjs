#!/usr/bin/env node
/**
 * Records a cassette of a real Codex CLI (`codex exec --json`) session.
 *
 * Usage:
 *   node test/behavioral/record-codex-cassette.mjs <scenario> "<prompt>" \
 *     [--resume <thread-id>] [--cwd <dir>] [--profile <name>]
 *
 * Output: test/behavioral/cassettes/codex-<scenario>-<profile>.jsonl
 * (profile defaults to "default")
 */

import { spawn } from 'child_process'
import { writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outputDir = resolve(__dirname, 'cassettes')

const args = process.argv.slice(2)
if (args.length < 2) {
  console.error('Usage: record-codex-cassette.mjs <scenario> "<prompt>" [--resume <id>] [--cwd <dir>]')
  process.exit(1)
}

const scenario = args[0]
const prompt = args[1]

let resumeId = null
let cwd = process.env.HOME + '/src/lattice-orchestrator'
let profile = 'default'
let modelOverride = null
for (let i = 2; i < args.length; i++) {
  if (args[i] === '--resume' && args[i + 1]) { resumeId = args[i + 1]; i++ }
  else if (args[i] === '--cwd' && args[i + 1]) { cwd = resolve(args[i + 1]); i++ }
  else if (args[i] === '--profile' && args[i + 1]) { profile = args[i + 1]; i++ }
  else if (args[i] === '--model' && args[i + 1]) { modelOverride = args[i + 1]; i++ }
}

const tag = modelOverride ? modelOverride.replace(/[^a-zA-Z0-9.-]/g, '_') : profile
const outputPath = resolve(outputDir, `codex-${scenario}-${tag}.jsonl`)
const codexBin = process.env.CODEX_BIN || 'codex'

const codexArgs = ['exec', '--profile', profile]
if (modelOverride) codexArgs.push('-c', `model=${modelOverride}`)
if (resumeId) codexArgs.push('resume', resumeId)
codexArgs.push('--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', prompt)

console.log(`Recording: codex-${scenario}`)
console.log(`  bin: ${codexBin}`)
console.log(`  cwd: ${cwd}`)
console.log(`  args: ${codexArgs.join(' ')}`)
if (resumeId) console.log(`  resuming: ${resumeId}`)
console.log(`  output: ${outputPath}`)

const entries = [JSON.stringify({ type: 'meta', ts: 0, format: 1 })]
const startTime = Date.now()

const child = spawn(codexBin, codexArgs, {
  cwd,
  env: {
    ...process.env,
    NODE_OPTIONS: '',
    VSCODE_INSPECTOR_OPTIONS: '',
  },
  // Codex 0.125+ waits on stdin if it sees a piped stdin, even with an argv
  // prompt. Use 'ignore' so Codex doesn't think stdin is being fed.
  stdio: ['ignore', 'pipe', 'pipe'],
})

let buffer = ''
let capturedThreadId = null

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
      if (evt.type === 'thread.started' && evt.thread_id) {
        capturedThreadId = evt.thread_id
        console.log(`  [${ts}ms] thread.started: ${evt.thread_id}`)
      } else if (evt.type === 'turn.started') {
        console.log(`  [${ts}ms] turn.started`)
      } else if (evt.type === 'item.completed') {
        const item = evt.item ?? {}
        const itemType = item.type ?? '?'
        let preview = ''
        if (itemType === 'agent_message') preview = (item.text ?? '').slice(0, 80)
        else if (itemType === 'reasoning') preview = (item.text ?? '').slice(0, 80)
        else if (itemType === 'command_execution') preview = (item.command ?? '').slice(0, 80)
        console.log(`  [${ts}ms] item.completed [${itemType}] ${preview}`)
      } else if (evt.type === 'turn.completed') {
        console.log(`  [${ts}ms] turn.completed`)
      } else {
        console.log(`  [${ts}ms] ${evt.type}`)
      }
    } catch { /* ignore parse errors */ }
  }
})

let stderrBuf = ''
child.stderr.on('data', (chunk) => {
  stderrBuf += chunk.toString()
})

child.on('close', (code, signal) => {
  clearTimeout(killTimer)
  const ts = Date.now() - startTime
  entries.push(JSON.stringify({ type: 'exit', ts, code: code ?? 0, signal: signal ?? undefined }))

  mkdirSync(outputDir, { recursive: true })
  writeFileSync(outputPath, entries.join('\n') + '\n')

  console.log(`\nRecorded ${entries.length} entries in ${ts}ms`)
  console.log(`Saved to: ${outputPath}`)
  if (capturedThreadId) console.log(`thread_id: ${capturedThreadId}`)
  if (stderrBuf.trim()) {
    console.log('\n--- stderr ---')
    console.log(stderrBuf.trim())
  }
})

const timeoutMs = parseInt(process.env.CODEX_TIMEOUT_MS || '240000', 10)
const killTimer = setTimeout(() => {
  console.log(`\nTimeout (${timeoutMs}ms) — killing codex process`)
  child.kill('SIGTERM')
}, timeoutMs)
