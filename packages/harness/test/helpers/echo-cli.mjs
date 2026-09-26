#!/usr/bin/env node
/**
 * Stands in for the `claude` binary in ClaudeInteractiveAdapter tests.
 *
 * Point the adapter at this script with `{ claudeBin: ECHO_CLI_PATH }` and it
 * reports back, as JSON lines on stdout, exactly what the adapter did to it:
 * the argv it was spawned with, the env it inherited, and every line written
 * to its stdin. Like the real CLI in `--input-format stream-json` mode it
 * stays alive reading stdin rather than exiting after the first message, so
 * keep-alive behaviour is exercised too.
 *
 * Env values are only echoed for `HARNESS_TEST_*` keys — everything else is
 * reported by name only, so a failing assertion cannot dump the developer's
 * real environment into test output.
 */
import { createInterface } from 'node:readline'

const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

const testEnv = {}
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('HARNESS_TEST_')) testEnv[key] = value
}

line({ kind: 'argv', argv: process.argv.slice(2) })
line({ kind: 'env', keys: Object.keys(process.env).sort(), values: testEnv })
line({ kind: 'cwd', cwd: process.cwd() })

const rl = createInterface({ input: process.stdin })
rl.on('line', (raw) => line({ kind: 'stdin', raw }))
rl.on('close', () => process.exit(0))
