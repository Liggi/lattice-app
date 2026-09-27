import { describe, expect, it } from 'vitest';
import { activitySinceReport, describeDrift, inputStarter, type WorkerLogRow } from '../../src/services/sessions/worker-drift';
import type { WorkerState } from '../../src/types/worker-events';

/**
 * 2026-09-27: a courier session delivered a worker the key it had reported
 * waiting on. The worker worked for twenty minutes; its coordinator, told
 * nothing, said it was idle. The coordinator is now shown who started the
 * worker since its report.
 */
const COORD = 'conv-coord';
const input = (seq: number, text: string): WorkerLogRow => ({ seq, timestamp: seq * 1000, type: 'input:sent', text });
const output = (seq: number): WorkerLogRow => ({ seq, timestamp: seq * 1000, type: 'content' });
const end = (seq: number): WorkerLogRow => ({ seq, timestamp: seq * 1000, type: 'turn:end' });

describe('a worker started by someone else since its report', () => {
  it('names the sender from the prefix the server writes', () => {
    expect(inputStarter('[From an unidentified sender (a `session send` with no --from) · 11:53]\nkey')).toMatch(/^an unidentified sender/);
    expect(inputStarter('[From conv-other · 11:53]\nhi')).toBe('conv-other');
    expect(inputStarter('[From the server · 11:31]\nyour report says')).toBe('a server note');
    expect(inputStarter('carry on with the bot')).toMatch(/typing into it directly$/);
    expect(inputStarter('/compact')).toBeNull();
    expect(inputStarter('[Context restored after compaction]')).toBeNull();
  });

  it('is running while its turn has not ended', () => {
    const activity = activitySinceReport([input(10, '[From an unidentified sender · 11:53]\nkey'), output(11), output(12)], COORD);
    expect(activity).toEqual({ starters: ['an unidentified sender (a `session send` with no --from)'], turnSeq: 10, firstAt: 10_000, running: true });
  });

  it('is between turns once the turn ends', () => {
    expect(activitySinceReport([input(10, '[From conv-other · 1]\nx'), output(11), end(12)], COORD)?.running).toBe(false);
  });

  it('says nothing when only the coordinator restarted it', () => {
    expect(activitySinceReport([input(10, `[From ${COORD} · 1]\ngo on`), output(11)], COORD)).toBeNull();
  });

  it('counts output with no input before it as a Monitor or background task', () => {
    const activity = activitySinceReport([output(10), output(11)], COORD);
    expect(activity?.starters).toEqual(['a background task or Monitor']);
    expect(activity?.turnSeq).toBe(10);
  });

  it('moves turnSeq to the latest turn, so a new one is shown again', () => {
    const activity = activitySinceReport([input(10, '[From conv-a · 1]\nx'), end(11), input(20, '[From conv-b · 2]\ny'), output(21)], COORD);
    expect(activity).toMatchObject({ starters: ['conv-a', 'conv-b'], turnSeq: 20, firstAt: 10_000, running: true });
  });

  it('says what the last report claimed next to what is true now', () => {
    const state: WorkerState = {
      worker: 'conv-w', provider: 'claude', model: null, task: 'Build the forecasting bot', thread: 213,
      startedAt: 0, phase: 'reported', question: null, since: 5_000, waitingOn: 'the Metaculus token', workedSinceReport: true,
    };
    const line = describeDrift(state, { starters: ['conv-other'], turnSeq: 10, firstAt: 10_000, running: true });
    expect(line).toMatch(/^- conv-w \(Build the forecasting bot\): working now, since .+, on input from conv-other, not you, with no report since\. Its last report to you \(.+\) said it was waiting on the Metaculus token\.$/);
  });
});
