/**
 * A waiting worker's declared wait, shortened to finish "Waiting for …" on
 * its card: "a turn on the PC", "the next restart".
 *
 * Workers declare a wait in their own words, addressed to the coordinator
 * ("front's message that the CK3 slot is mine"), and five workers waiting on
 * one thing write it five ways. On 2026-10-10 Jason saw a panel of rows that
 * each said only "Waiting" and could not tell what any of them waited for
 * (thread 37369). The card now shows the reason on the row, in this phrase.
 *
 * The writer is shown the phrases already on the same panel and told to reuse
 * one word for word when the wait is the same thing, so one shared wait reads
 * the same on every row. A coordinator's waits are therefore phrased one at a
 * time, never in parallel.
 *
 * Bounds, the same as `worker-activity.ts` and under the same gate
 * (`generation.workerActivity`): only while the coordinator's panel is open,
 * and only once per declared wait. A phrase is kept against the exact text it
 * was written from and served only while the worker still declares that text,
 * so an unchanged wait is never phrased twice and a new one never shows a
 * stale phrase. Until a phrase exists the card shows the worker's own words.
 */

import type Database from 'better-sqlite3';
import { backgroundTextClient, backgroundProvenance } from '../infrastructure/background-text-client.js';
import { DatabaseProvider } from '../infrastructure/database-provider.js';
import { allowGeneration } from '../infrastructure/generation-gates.js';
import { getCostTracker } from '../infrastructure/cost-tracker.js';
import { createLogger } from '../infrastructure/logger.js';
import { readWorkerStates } from './worker-events.js';
import { activityModel, getWorkerActivityService } from './worker-activity.js';
import { userName } from '../user-profile.js';

const logger = createLogger('WorkerWaitPhrase');

const MAX_PHRASE_CHARS = 40;
const MAX_PHRASE_WORDS = 7;
const MAX_OUTPUT_TOKENS = 32;

function db(): Database.Database {
  return DatabaseProvider.getInstance().getDb();
}

interface PhraseRow {
  worker: string;
  coordinator: string;
  wait_text: string;
  text: string;
  model: string;
  at: string;
}

function readRows(coordinator: string): PhraseRow[] {
  try {
    return db().prepare('SELECT * FROM worker_wait_phrase WHERE coordinator = ?').all(coordinator) as PhraseRow[];
  } catch (err) {
    logger.debug('Wait phrase read failed', { coordinator, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/** Worker → its phrase, for the waits still declared exactly as they were phrased. */
export function readWaitPhrases(coordinator: string, waits: ReadonlyMap<string, string>): Map<string, string> {
  const phrases = new Map<string, string>();
  for (const row of readRows(coordinator)) {
    if (waits.get(row.worker) === row.wait_text) phrases.set(row.worker, row.text);
  }
  return phrases;
}

/** The whole prompt, exported so tests can see what the writer is told. */
export function buildWaitPrompt(
  task: string,
  wait: string,
  onPanel: readonly { wait: string; phrase: string }[],
  unphrased: readonly string[] = [],
): { system: string; user: string } {
  const system = [
    `You shorten what a worker is waiting for, for its row in ${userName()}'s project panel. The row reads`,
    '"Waiting for <your phrase>" under the worker\'s task, on a phone, and must fit one line.',
    '',
    'Write 2 to 6 words that finish "Waiting for", lower case unless a name, no full stop: "a turn on the PC",',
    '"the next restart", "the Stellaris run to finish".',
    `- Name the thing itself, in words ${userName()} would use. Workers write their waits to the coordinator, often`,
    '  as the message or go-ahead that will release them ("front\'s message that the slot is mine"). When the',
    '  coordinator is handing out turns on something shared, the wait is for a turn on that thing ("a turn on the',
    '  build machine"): not the message, not the go-ahead, and not what this worker will use its turn for, since',
    '  other workers are waiting for the same turn.',
    `- Say "the coordinator" for front or the coordinator, and "you" for ${userName()}, only when the wait really is`,
    '  on their reply or decision.',
    '- Leave out every other internal id: background task, shell and tmux session names or ids ("bwwmwfqln"),',
    '  process ids, job numbers, and the plumbing around them ("which notifies me when done"). Say what the job',
    '  is doing: "the Chinese re-ranking to finish", not "background job bwwmwfqln".',
    '- When the wait names a session by id (conv-…), keep that id exactly as written; the panel makes it readable.',
    '- When the wait is the same thing as one already on the panel, answer with that phrase exactly, character for',
    '  character, even if this worker words it differently.',
    '',
    'Answer with the phrase alone.',
  ].join('\n');
  const user = [
    'The worker\'s task:',
    task,
    '',
    'What it says it is waiting on:',
    wait,
    '',
    'Waits already on the panel, as declared and as phrased:',
    onPanel.length > 0 ? onPanel.map((entry) => `${entry.wait}\n  → ${entry.phrase}`).join('\n') : '(none)',
    '',
    'Other waits on the panel, not phrased yet; one thing several of them share is what to name:',
    unphrased.length > 0 ? unphrased.join('\n') : '(none)',
  ].join('\n');
  return { system, user };
}

/** The phrase, if the model wrote one that fits the row. */
export function usableWaitPhrase(raw: string): string | null {
  const text = raw.replace(/\s+/g, ' ').trim().replace(/^["']|["'.]+$/g, '').replace(/^waiting (for|on)\s+/i, '').trim();
  if (!text) return null;
  if (text.length > MAX_PHRASE_CHARS) return null;
  if (text.split(' ').filter(Boolean).length > MAX_PHRASE_WORDS) return null;
  return text;
}

/** A coordinator's declared waits, worker → text, as the panel shows them. */
function declaredWaits(coordinator: string): { waits: Map<string, string>; tasks: Map<string, string> } {
  const waits = new Map<string, string>();
  const tasks = new Map<string, string>();
  for (const state of readWorkerStates(coordinator)) {
    if (state.phase === 'reported' && !state.workedSinceReport && state.waitingOn) {
      waits.set(state.worker, state.waitingOn);
      tasks.set(state.worker, state.task);
    }
  }
  return { waits, tasks };
}

const running = new Set<string>();
const again = new Set<string>();

/**
 * Phrase this coordinator's waits that have none yet. Called when its panel
 * opens and when a worker reports. Never rejects.
 */
export function noteWorkerWaits(coordinator: string): void {
  if (!allowGeneration('workerActivity')) return;
  if (!getWorkerActivityService().isWatched(coordinator)) return;
  if (running.has(coordinator)) {
    again.add(coordinator);
    return;
  }
  running.add(coordinator);
  void phraseWaits(coordinator)
    .catch((err) => logger.debug('Wait phrasing failed', { coordinator, error: err instanceof Error ? err.message : String(err) }))
    .finally(() => {
      running.delete(coordinator);
      if (again.delete(coordinator)) noteWorkerWaits(coordinator);
    });
}

async function phraseWaits(coordinator: string): Promise<void> {
  const { waits, tasks } = declaredWaits(coordinator);
  const phrased = readWaitPhrases(coordinator, waits);
  const missing = [...waits.keys()].filter((worker) => !phrased.has(worker));
  if (missing.length === 0) return;

  const client = backgroundTextClient.getClient('workerActivity');
  if (!client) {
    logger.debug('No Anthropic client; waiting rows keep the worker\'s own words', { coordinator });
    return;
  }
  const model = activityModel();
  const service = getWorkerActivityService();
  for (const worker of missing) {
    if (!service.isWatched(coordinator)) return;
    const wait = waits.get(worker)!;
    const onPanel = [...phrased].map(([other, phrase]) => ({ wait: waits.get(other)!, phrase }));
    const unphrased = [...waits].filter(([other]) => other !== worker && !phrased.has(other)).map(([, text]) => text);
    const prompt = buildWaitPrompt(tasks.get(worker) ?? '', wait, onPanel, unphrased);
    const started = Date.now();
    const response = await client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      thinking: { type: 'disabled' },
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
    });
    const durationMs = Date.now() - started;
    try {
      getCostTracker().log({
        sessionId: worker,
        operation: 'WORKER_WAIT_PHRASE',
        ...backgroundProvenance(response, model),
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cacheCreationInputTokens: response.usage?.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: response.usage?.cache_read_input_tokens ?? 0,
        durationMs,
      });
    } catch (err) {
      logger.debug('Cost tracking failed', { error: err });
    }
    const raw = response.content.map((block) => (block.type === 'text' ? block.text : '')).join(' ');
    const phrase = usableWaitPhrase(raw);
    if (!phrase) {
      logger.debug('No usable wait phrase; the row keeps the worker\'s own words', { worker, model, raw });
      continue;
    }
    db().prepare(
      `INSERT INTO worker_wait_phrase (worker, coordinator, wait_text, text, model, at)
       VALUES (@worker, @coordinator, @wait_text, @text, @model, @at)
       ON CONFLICT(worker) DO UPDATE SET
         coordinator = excluded.coordinator, wait_text = excluded.wait_text,
         text = excluded.text, model = excluded.model, at = excluded.at`,
    ).run({ worker, coordinator, wait_text: wait, text: phrase, model: response.model || model, at: new Date().toISOString() });
    phrased.set(worker, phrase);
    logger.info('Wait phrase written', { worker, model, ms: durationMs, text: phrase });
    service.emit('changed', { coordinator, worker });
  }
}
