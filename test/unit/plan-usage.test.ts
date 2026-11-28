import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ClaudePlanUsageService, parseClaudeUsageText } from '../../src/services/infrastructure/claude-plan-usage.js';
import { estimateGeminiSpend, neonTurnUsd } from '../../src/services/infrastructure/gemini-spend.js';

// Text `claude -p /usage` printed on 22 Nov 2026 (Claude Code on a Max plan), plus a session line.
const USAGE_TEXT = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 12% used · resets 7pm (Europe/London)',
  'Current week (all models): 58% used · resets Nov 27 at 2:59am (Europe/London)',
  'Current week (Fable): 28% used · resets Nov 27 at 2:59am (Europe/London)',
  '',
  'Last 24h · 5982 requests · 68 sessions',
  '  69%  Run fewer sessions at once · up to 10 at once',
].join('\n');

describe('Claude plan usage', () => {
  it('reads every limit line and nothing from the advice below them', () => {
    expect(parseClaudeUsageText(USAGE_TEXT)).toEqual([
      { window: 'session', scope: null, percentUsed: 12, resets: '7pm (Europe/London)' },
      { window: 'week', scope: 'all models', percentUsed: 58, resets: 'Nov 27 at 2:59am (Europe/London)' },
      { window: 'week', scope: 'Fable', percentUsed: 28, resets: 'Nov 27 at 2:59am (Europe/London)' },
    ]);
  });

  it('runs the CLI once per ten minutes and reports output with no limits as unavailable', async () => {
    let now = 0;
    let runs = 0;
    const outputs = [JSON.stringify({ result: USAGE_TEXT }), JSON.stringify({ result: 'Not logged in' })];
    const service = new ClaudePlanUsageService(async () => outputs[runs++], () => now);
    expect((await service.get()).state).toBe('ok');
    now = 5 * 60_000;
    await service.get();
    expect(runs).toBe(1);
    now = 11 * 60_000;
    await service.get(); // stale: answered from cache while the refresh runs
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await service.get()).toMatchObject({ state: 'unavailable', reason: 'Not logged in' });
  });
});

describe('Gemini spend estimate', () => {
  it('prices a turn at Neon list price, cache reads at the cached rate', () => {
    expect(neonTurnUsd({ input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 })).toBeCloseTo(18.15);
  });

  it('counts Neon turns with tokens and reports the rest as not counted', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE conversation_segments (conversation_id TEXT, provider TEXT, model TEXT, created_at TEXT);
             CREATE TABLE harness_events (session_id TEXT, seq INTEGER, type TEXT, timestamp INTEGER, data TEXT);`);
    const now = Date.parse('2026-11-22T20:00:00Z');
    const segment = db.prepare('INSERT INTO conversation_segments VALUES (?, ?, ?, ?)');
    segment.run('conv-endpoint', 'claude', 'google/gemini-4-neon', '2026-11-21T10:00:00Z');
    segment.run('conv-endpoint', 'claude', 'claude-opus-5-5', '2026-11-22T19:00:00Z');
    segment.run('conv-agy', 'antigravity', 'agy:gemini-4-neon-high', '2026-11-22T15:00:00Z');
    const turn = db.prepare(`INSERT INTO harness_events VALUES (?, 0, 'turn:end', ?, ?)`);
    const usage = (output: number) => JSON.stringify({ usage: { input_tokens: 0, output_tokens: output } });
    turn.run('conv-endpoint', Date.parse('2026-11-21T12:00:00Z'), usage(1_000_000)); // yesterday: $15
    turn.run('conv-endpoint', Date.parse('2026-11-22T12:00:00Z'), JSON.stringify({ usage: { input_tokens: 0, output_tokens: 0 } })); // no counts
    turn.run('conv-endpoint', Date.parse('2026-11-22T19:30:00Z'), usage(5)); // after the switch to Opus: not Gemini
    turn.run('conv-agy', Date.parse('2026-11-22T16:00:00Z'), usage(9_000_000)); // agy running total, before the fix
    turn.run('conv-agy', Date.parse('2026-11-22T18:00:00Z'), usage(2_000_000)); // today: $30

    const spend = estimateGeminiSpend(db, now);
    expect(spend.today).toEqual({ usd: 30, countedTurns: 1, uncountedTurns: 2 });
    expect(spend.last7Days).toEqual({ usd: 45, countedTurns: 2, uncountedTurns: 2 });
    expect(spend.budget).toEqual({ usd: 45, countedTurns: 2, uncountedTurns: 2, limitUsd: 500, days: 30 });
  });
});
