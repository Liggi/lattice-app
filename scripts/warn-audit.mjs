#!/usr/bin/env node
/**
 * Warn budget for the live server log.
 *
 * A sustained WARN is a bug: on 2026-08-28 one warning ("status liveness
 * disagreement") hit 6,591 lines and buried every real signal in the log.
 * This audit reads the server's logs/server.jsonl since the current server
 * boot, tallies WARN/ERROR lines by message, and fails when any
 * non-allowlisted message exceeds the per-boot budget — so log noise breaks
 * a gate instead of accumulating silently.
 *
 * Usage: npx tsx scripts/warn-audit.mjs [--budget N] [--since-iso TIMESTAMP]
 * (also wired as `pnpm warn-audit`; run it after a deploy has soaked)
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { CONFIG_DIR } from '../src/utils/constants.js';

const LOG_PATH = path.join(CONFIG_DIR, 'logs', 'server.jsonl');
const BOOT_MARKER = 'Server listening';

// Known-benign warnings. Add sparingly, with a reason — every entry here is
// noise the next investigator has to read around.
const ALLOWLIST = [
  // Slow-response telemetry on genuinely large list payloads; tracked by the
  // projection work, not a malfunction.
  '[CONV] Slow list response',
];

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const budget = Number(argValue('--budget') ?? '5');
const sinceIso = argValue('--since-iso');

if (!fs.existsSync(LOG_PATH)) {
  console.error(`warn-audit: ${LOG_PATH} not found`);
  process.exit(2);
}

// Pino levels: 40 = warn, 50 = error, 60 = fatal. The formatter also writes
// string levels in some configurations, so accept both encodings.
function severity(entry) {
  const level = entry.level;
  if (level === 40 || level === 'warn') return 'WARN';
  if (level === 50 || level === 60 || level === 'error' || level === 'fatal') return 'ERROR';
  return null;
}

const rl = readline.createInterface({
  input: fs.createReadStream(LOG_PATH),
  crlfDelay: Infinity,
});

let sinceMs = sinceIso ? Date.parse(sinceIso) : null;
let lastBootMs = null;
let suppressedSuspensionLines = 0;
const tally = new Map(); // `${sev} ${msg}` → { count, firstAt, lastAt, sev, msg }
const rows = [];

for await (const line of rl) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    continue;
  }
  const timeMs = Date.parse(entry.time);
  if (!Number.isFinite(timeMs)) continue;
  if (typeof entry.msg === 'string' && entry.msg.includes(BOOT_MARKER)) {
    lastBootMs = timeMs;
    rows.push({ kind: 'boot', timeMs });
    continue;
  }
  const sev = severity(entry);
  if (!sev) continue;
  // Browser-reported timeouts whose timers overshot their own budget are a
  // tab-suspension artifact, not a server or network fault — the client
  // stamps the verdict because it is the only party that can see it.
  if (entry.details?.suspectedTabSuspension === true) {
    suppressedSuspensionLines += 1;
    continue;
  }
  // Every client telemetry line shares the msg "[CLIENT-TELEMETRY]"; the
  // event name is what actually distinguishes them.
  const msg = entry.msg === '[CLIENT-TELEMETRY]' && entry.event
    ? `[CLIENT-TELEMETRY] ${entry.event}`
    : entry.msg ?? '(no msg)';
  rows.push({ kind: 'line', timeMs, sev, msg, component: entry.component ?? '' });
}

const windowStartMs = sinceMs ?? lastBootMs ?? 0;
for (const row of rows) {
  if (row.kind !== 'line' || row.timeMs < windowStartMs) continue;
  const key = `${row.sev} [${row.component}] ${row.msg}`;
  const existing = tally.get(key);
  if (existing) {
    existing.count += 1;
    existing.lastAt = row.timeMs;
  } else {
    tally.set(key, { count: 1, firstAt: row.timeMs, lastAt: row.timeMs, key });
  }
}

const sorted = Array.from(tally.values()).sort((a, b) => b.count - a.count);
const windowLabel = new Date(windowStartMs).toISOString();
if (suppressedSuspensionLines > 0) {
  console.log(`warn-audit: ignored ${suppressedSuspensionLines} line(s) tagged suspectedTabSuspension (tab wake bursts, not faults)`);
}
console.log(`warn-audit: WARN/ERROR since ${sinceIso ? `--since-iso ${windowLabel}` : `last boot (${windowLabel})`}\n`);

if (sorted.length === 0) {
  console.log('  clean — no WARN or ERROR lines in the window');
  process.exit(0);
}

let breaches = 0;
for (const item of sorted) {
  const allowlisted = ALLOWLIST.some((allowed) => item.key.includes(allowed));
  const overBudget = !allowlisted && item.count > budget;
  if (overBudget) breaches += 1;
  const mark = overBudget ? 'OVER-BUDGET' : allowlisted ? 'allowlisted' : 'ok';
  console.log(`  ${String(item.count).padStart(6)}  ${mark.padEnd(12)} ${item.key}`);
}

if (breaches > 0) {
  console.log(`\nwarn-audit: FAIL — ${breaches} message(s) over the per-boot budget of ${budget}`);
  process.exit(1);
}
console.log(`\nwarn-audit: PASS — nothing over the per-boot budget of ${budget}`);
