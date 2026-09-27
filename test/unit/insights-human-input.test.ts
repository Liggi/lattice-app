/**
 * Session insights read only what the user wrote. On 2026-09-26 the prompt
 * was 98% server-written input (project-record nudges, compaction restores,
 * worker reports, agent messages), ~44k tokens a call. With less to go on,
 * the model may decline, and a decline must not blank the title or re-ask.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setGenerationOverridesForTests } from '@/services/infrastructure/generation-gates.js';
import { capMessage, humanTextOfInput, isGenericFolder, pickupBriefOf, unsupportedDetails } from '../../src/services/insights/human-input.js';
import { anthropicService, normalizeMissionText } from '../../src/services/insights/anthropic-service.js';
import { InsightsEngine, type InsightsRecord } from '../../src/services/insights/insights-engine.js';

const NAME = 'alex';

describe('humanTextOfInput', () => {
  it('keeps a plain message the user typed', () => {
    expect(humanTextOfInput('yeah do it', NAME)).toBe('yeah do it');
  });

  it('drops server notes and a compaction restore, keeping the user message under them', () => {
    const input = [
      '[From the server: The project record has moved since you last saw it. This is where it stands.',
      'lots of record text',
      '[End of server note]',
      '[Context restored after compaction. Your context was just compacted.',
      'roster and preamble',
      '[End of restored context]',
      'can we make insights cheaper',
    ].join('\n');
    expect(humanTextOfInput(input, NAME)).toBe('can we make insights cheaper');
  });

  it('drops an input that is only a server note over another agent message', () => {
    const input = '[From the server: One message, delivered into the turn you are running.]\n[End of server note]\n[From conv-abc · 22:23]\nGo ahead with option B';
    expect(humanTextOfInput(input, NAME)).toBeNull();
  });

  it('drops agent messages, including ones relaying the user', () => {
    expect(humanTextOfInput('[From conv-abc · 12:12]\nThe data volume is full', NAME)).toBeNull();
    expect(humanTextOfInput("[From conv-abc, relaying alex's decision · 17:55]\nGo with A", NAME)).toBeNull();
    expect(humanTextOfInput('[From the server · 12:00] The Lattice server restarted', NAME)).toBeNull();
  });

  it('drops worker reports and questions', () => {
    expect(humanTextOfInput('[Report from worker conv-abc · claude-opus-5-5 · [12]]\n\nDone.', NAME)).toBeNull();
    expect(humanTextOfInput('[Question from worker conv-abc · [3]. It has stopped.]\n\nWhich one?', NAME)).toBeNull();
  });

  it("drops a worker's pickup brief, which its coordinator wrote", () => {
    const input = 'Picked up from conv-front (front, claude) · you are conv-w · cwd /x\nOrient: ...\n---\nThread 20715: investigate costs';
    expect(humanTextOfInput(input, NAME)).toBeNull();
  });

  it("keeps the user's opening message under a coordinator preamble", () => {
    const input = 'You are `front`: the project owner.\nRules...\n---\nhelp me cut the Anthropic bill';
    expect(humanTextOfInput(input, NAME)).toBe('help me cut the Anthropic bill');
  });

  it('keeps only the user items from a batched delivery', () => {
    const input = [
      '[Report from worker conv-a · opus · 21:40]\n\nFinished the thing.',
      '[From alex · 21:41]\nok ship it',
      '[From conv-b · 21:42]\nAlso done.',
      '[From Alex · 21:43]\nand tidy up after',
    ].join('\n\n');
    expect(humanTextOfInput(input, NAME)).toBe('ok ship it\n\nand tidy up after');
  });

  it('drops the fast responder answer appended to a user message', () => {
    const input = 'is it deployed?\n\n[Automatic quick answer from the fast responder while you were busy · 10:00. Use it as context.]\nYes, at 09:58.';
    expect(humanTextOfInput(input, NAME)).toBe('is it deployed?');
  });

  it('keeps the user annotation block, which the user wrote', () => {
    const input = '[Notes on your earlier output]\n1. Re: "x"\n   Note: wrong\n[/Notes]\nfix that';
    expect(humanTextOfInput(input, NAME)).toBe(input);
  });

  it('drops reactions, manual-stop lines and bare slash commands', () => {
    expect(humanTextOfInput('Alex reacted 👍 to your message of 12:00', NAME)).toBeNull();
    expect(humanTextOfInput('Alex stopped your worker conv-abc manually. They may be steering that session directly.', NAME)).toBeNull();
    expect(humanTextOfInput('/compact', NAME)).toBeNull();
  });
});

describe('capMessage', () => {
  it('leaves a short message whole', () => {
    expect(capMessage('short')).toBe('short');
  });

  it('keeps the start of a long message and says how much is left out', () => {
    const long = 'word '.repeat(1000).trim();
    const capped = capMessage(long, 1500);
    const kept = capped.slice(0, capped.indexOf(' … ['));
    expect(long.startsWith(kept)).toBe(true);
    expect(kept.endsWith('word')).toBe(true);
    expect(capped).toContain(`[message continues; ${long.length - kept.length} more characters not shown]`);
    expect(kept.length).toBeLessThanOrEqual(1500);
  });
});

describe('normalizeMissionText', () => {
  it('keeps version numbers whole', () => {
    expect(normalizeMissionText('Upgrade Analyst to Opus 5.5')).toBe('Upgrade Analyst to Opus 5.5');
    expect(normalizeMissionText('Prepare and publish lattice-app 0.2.0')).toBe('Prepare and publish lattice-app 0.2.0');
  });

  it('never cuts a long mission; fitting it is the model\'s job', () => {
    const long = 'Build CK3 mod replacing scripted events with dynamic character-driven narrative';
    expect(normalizeMissionText(long)).toBe(long);
  });
});

describe('unsupportedDetails', () => {
  it('flags a version the input does not contain', () => {
    expect(unsupportedDetails('Add Claude Opus 5', 'please add claude opus 5.5 to the picker')).toEqual(['5']);
  });

  it('flags a product the input never names', () => {
    expect(unsupportedDetails('Check entry counts via BigQuery', 'how many entries came in today?')).toEqual(['BigQuery']);
  });

  it('accepts details the input contains, in any case or spacing', () => {
    const input = 'fix SLING-10851 in gpt live, then ship lattice-app 0.2.0 for alex; opus 5 migration';
    expect(unsupportedDetails('Fix SLING-10851 in GPT-Live and ship lattice-app 0.2.0', input)).toEqual([]);
    expect(unsupportedDetails('Strip Alex-specific references', input)).toEqual([]);
    expect(unsupportedDetails('Migrate coordinators to Opus5', input)).toEqual([]);
  });

  it('lets short descriptive acronyms through', () => {
    expect(unsupportedDetails('Purge PII leak and fix UX', 'we leaked a name')).toEqual([]);
  });
});

describe('pickupBriefOf', () => {
  it("returns a worker's brief without the pickup preamble", () => {
    const input = 'Picked up from conv-front (front, claude) · you are conv-w\nOrient: ...\n---\nThread 20715: find out why the key costs $80/day';
    expect(pickupBriefOf(input)).toBe('Thread 20715: find out why the key costs $80/day');
  });

  it('returns null for anything else', () => {
    expect(pickupBriefOf('yeah do it')).toBeNull();
  });
});

/** An engine with only what the event reader and onTurnEnd touch; the real constructor opens the session DB. */
function engineOver(events: Array<{ type: string; data: unknown }>, existing: InsightsRecord | null, archived = false) {
  const engine = Object.create(InsightsEngine.prototype) as InsightsEngine;
  const stored: InsightsRecord[] = [];
  Object.assign(engine, {
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
    lastComputedAt: new Map<string, number>(),
    turnEndInFlight: new Set<string>(),
    db: {
      prepare: () => ({
        all: () => events.map((e) => ({ type: e.type, data: JSON.stringify(e.data) })),
        get: () => ({ archived: archived ? 1 : 0 }),
      }),
    },
    getInsightsRecord: async () => existing,
    setInsightsRecord: async (record: InsightsRecord) => { stored.push(record); },
  });
  return { engine, stored };
}

const typed = (text: string) => ({ type: 'input:sent', data: { text } });

describe('InsightsEngine insight inputs', () => {
  beforeEach(() => {
    __setGenerationOverridesForTests({ insights: true });
    vi.spyOn(anthropicService, 'isConfigured').mockReturnValue(true);
  });
  afterEach(() => {
    __setGenerationOverridesForTests(null);
    vi.restoreAllMocks();
  });

  it('joins a streamed Codex reply into one assistant response', async () => {
    const reply = (text: string) => ({ type: 'content', data: { messageId: 'codex-msg_1', blocks: [{ type: 'text', text }] } });
    const { engine } = engineOver([typed('first ask'), typed('second ask'), reply('Happy'), reply(' to'), reply(' play.')], null);
    const extract = vi.spyOn(anthropicService, 'extractSessionInsights').mockResolvedValue({ context: null, theme: '', categories: null, tags: null });
    await engine.onTurnEnd('conv-a');
    expect(extract.mock.calls[0][0]).toContain('- "Happy to play."');
  });

  it('keeps the previous mission when the model declines, and does not ask again for the same messages', async () => {
    const existing = {
      session_id: 'conv-a', context: { project: 'Lattice', area: null, mission: 'Cut insights cost', scope: 'feature' },
      tags: null, theme: 'pruning', categories: null, computed_at: '2026-09-26T00:00:00Z', stale: false, message_count: 1,
    } satisfies InsightsRecord;
    const { engine, stored } = engineOver([typed('cut the insights bill'), typed('yeah do it')], existing);
    const extract = vi.spyOn(anthropicService, 'extractSessionInsights').mockResolvedValue({ context: null, theme: '', categories: null, tags: null });

    await engine.onTurnEnd('conv-a');
    expect(stored).toEqual([{ ...existing, message_count: 2 }]);

    // The next turn brings no new user message: no second call.
    const again = engineOver([typed('cut the insights bill'), typed('yeah do it')], stored[0]);
    await again.engine.onTurnEnd('conv-a');
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('skips archived sessions, which include every fixture created archived', async () => {
    const { engine } = engineOver([typed('first ask'), typed('second ask')], null, true);
    const extract = vi.spyOn(anthropicService, 'extractSessionInsights');
    await engine.onTurnEnd('conv-a');
    expect(extract).not.toHaveBeenCalled();
  });

  it("builds a worker's insights from its brief, labelled as the coordinator's", async () => {
    const brief = { type: 'input:sent', data: { text: 'Picked up from conv-front (front) · you are conv-w\n---\nRemove the quick answers feature' } };
    const { engine } = engineOver([brief], null);
    const extract = vi.spyOn(anthropicService, 'extractSessionInsights').mockResolvedValue({ context: null, theme: '', categories: null, tags: null });
    await engine.onTurnEnd('conv-w');
    const prompt = extract.mock.calls[0][0];
    expect(prompt).toContain('Brief this session was started with (written by its coordinator, not the user');
    expect(prompt).toContain('"Remove the quick answers feature"');
    expect(prompt).toContain('User requests: none.');
  });

  it('asks the model once when two turn ends for a session arrive together', async () => {
    const { engine } = engineOver([typed('first ask'), typed('second ask')], null);
    const extract = vi.spyOn(anthropicService, 'extractSessionInsights').mockResolvedValue({ context: null, theme: '', categories: null, tags: null });
    await Promise.all([engine.onTurnEnd('conv-a'), engine.onTurnEnd('conv-a')]);
    expect(extract).toHaveBeenCalledTimes(1);
  });
});

describe('isGenericFolder', () => {
  const home = '/Users/alex';
  it('treats home, the launch folder and container folders as saying nothing about the project', () => {
    expect(isGenericFolder('/Users/alex', home, undefined)).toBe(true);
    expect(isGenericFolder('~', home, undefined)).toBe(true);
    expect(isGenericFolder('/Users/alex/src', home, undefined)).toBe(true);
    expect(isGenericFolder('/Users/alex/work/lattice', home, '~/work/lattice')).toBe(true);
    expect(isGenericFolder('/', home, undefined)).toBe(true);
    expect(isGenericFolder(undefined, home, undefined)).toBe(true);
  });
  it('keeps a folder that names a project', () => {
    expect(isGenericFolder('/Users/alex/src/recipe-planner', home, '~/src')).toBe(false);
  });
});
