/**
 * What a worker is doing right now, in one short phrase for its card.
 *
 * The user reads the right panel to know where the work stands without opening
 * a worker's session. The card already carries the task and a lifecycle word
 * ("Working"), which between a dispatch and a report says the same thing for
 * an hour. This adds the missing line: "Testing the composer", "Checking
 * worker reports", "Fixing the sidebar".
 *
 * The phrase has to be in the user's terms, not the worker's, where
 * "checking the final-reply boundary" means nothing, and that is the whole
 * difficulty: a worker's own vocabulary is about its files and its
 * abstractions. So the writer is given the coordinator's task
 * line — written for the user at dispatch — as the vocabulary to stay inside,
 * and the work evidence only to say which part of that task is happening.
 * A phase word on its own ("Investigating") is a good answer when the
 * evidence supports nothing more specific.
 *
 * Bounds, because this bills an API key on the workers' schedule rather than
 * on a user's action:
 *
 * - Gated by `generation.workerActivity`, closed by default.
 * - One assessment per worker at a time. Evidence arriving during a run
 *   schedules exactly one more; it does not queue a run per event.
 * - `MIN_GAP_MS` between a worker's assessments.
 * - Unchanged evidence is never re-assessed: the stored row carries the seq
 *   of the last event that gave it anything to say, and a worker that has
 *   only thought or only accumulated tool results since is served from the
 *   store rather than described again. (The same rule as `planAmbientScan` in
 *   scripts/ambient-scan.ts, which retains a read when the source revision
 *   is unchanged; for one worker it is a seq comparison rather than that
 *   script's roster and eligibility planning.)
 *
 * Truthfulness: the phrase is present tense, so it is only true while the
 * worker is working on the instruction it was written from. `turnSeq` is the
 * `input:sent` the worker was answering; the endpoint serves the row only
 * for that turn and only while the worker's phase is `working`, so a
 * question, a report, a stop or a new instruction retires it. A model result
 * that lands after any of those is dropped rather than stored, because by
 * then it describes work that has finished.
 */

import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { anthropicClientFactory } from '../infrastructure/anthropic-client-factory.js';
import { ConfigService } from '../infrastructure/config-service.js';
import { DatabaseProvider } from '../infrastructure/database-provider.js';
import { allowGeneration } from '../infrastructure/generation-gates.js';
import { getCostTracker } from '../infrastructure/cost-tracker.js';
import { createLogger } from '../infrastructure/logger.js';
import { DEFAULT_MODELS } from '../insights/anthropic-service.js';
import { eventsToUnifiedMessages, getEventStorage } from '../../harness/event-message-reader.js';
import type { UnifiedMessage } from '../../types/unified-messages.js';
import { ConversationService } from './conversation-service.js';
import { readWorkerStates } from './worker-events.js';
import { userName } from '../user-profile.js';

const logger = createLogger('WorkerActivity');

/**
 * Least time between one worker's assessments. A starting policy, not a
 * measured ideal — `scripts/ambient-watch.ts` uses the same 20s floor.
 */
export const MIN_GAP_MS = 20_000;

/** Events read back per assessment. Bounded: a long turn must not grow the read. */
const TAIL_EVENTS = 600;
/** Messages of the current turn given to the writer, newest last. */
const EVIDENCE_MESSAGES = 14;
/** A whole message this long is named rather than included. */
const MESSAGE_CHARS = 2_000;
/** A whole tool detail this long is named rather than included. */
const TOOL_DETAIL_CHARS = 400;
const MAX_PHRASE_CHARS = 48;
const MAX_PHRASE_WORDS = 6;
const MAX_OUTPUT_TOKENS = 32;

export interface WorkerActivity {
  worker: string;
  text: string;
  /** The `input:sent` this describes work on; the phrase retires with that turn. */
  turnSeq: number;
  /** Last event seq that contributed to `work`; unmoved means nothing new to say. */
  evidenceSeq: number;
  at: number;
}

/** The quick tier, as the insights service already resolves it. A phrase, written often. */
export function activityModel(): string {
  try {
    return ConfigService.getInstance().getConfig().anthropic?.models?.quickCheck?.trim() || DEFAULT_MODELS.quickCheck;
  } catch {
    return DEFAULT_MODELS.quickCheck;
  }
}

// ---------------------------------------------------------------------------
// Store

function db(): Database.Database {
  return DatabaseProvider.getInstance().getDb();
}

interface ActivityRow {
  worker: string;
  coordinator: string;
  text: string;
  turn_seq: number;
  evidence_seq: number;
  model: string;
  at: string;
}

function readRow(worker: string): ActivityRow | null {
  try {
    return (db().prepare('SELECT * FROM worker_activity WHERE worker = ?').get(worker) as ActivityRow | undefined) ?? null;
  } catch (err) {
    logger.debug('Activity read failed', { worker, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function writeRow(row: ActivityRow): void {
  db()
    .prepare(
      `INSERT INTO worker_activity (worker, coordinator, text, turn_seq, evidence_seq, model, at)
       VALUES (@worker, @coordinator, @text, @turn_seq, @evidence_seq, @model, @at)
       ON CONFLICT(worker) DO UPDATE SET
         coordinator = excluded.coordinator,
         text = excluded.text,
         turn_seq = excluded.turn_seq,
         evidence_seq = excluded.evidence_seq,
         model = excluded.model,
         at = excluded.at`,
    )
    .run(row);
}

/**
 * The phrase for a worker's card, or null when there is none to show. Null is
 * the ordinary case, not a failure: the card falls back to its lifecycle
 * line, which is still useful. Nothing on the card ever says the activity is
 * missing — failures are in the server log.
 */
export function readWorkerActivity(worker: string, phase: string): string | null {
  if (phase !== 'working') return null;
  const row = readRow(worker);
  if (!row) return null;
  // The phrase is present tense: it stops being true the moment the turn it
  // describes ends, is stopped, or is superseded by a new instruction.
  if (!stillCurrent(worker, row.turn_seq)) return null;
  return row.text;
}

// ---------------------------------------------------------------------------
// Evidence

export interface ActivityEvidence {
  /** What the coordinator last told the worker, as written. */
  instruction: string;
  /** What has happened since, oldest first: the worker's own messages and its tool calls. */
  work: string[];
  turnSeq: number;
  evidenceSeq: number;
}

/** A whole value, or a note that it was left out. Never a clipped half-sentence. */
function wholeOrNamed(value: string, maxChars: number, label: string): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `[${label}, ${clean.length} characters]`;
}

/**
 * The current turn, read back from the worker's log. Exported for tests.
 *
 * Thinking blocks are not evidence: they are the worker reasoning about what
 * it might do, and a phrase written from them describes work that may never
 * have happened. Tool results are left out too — they say what came back,
 * not what the worker is doing, and they are most of the bytes.
 */
export function readActivityEvidence(events: readonly SessionEvent[]): ActivityEvidence | null {
  if (events.length === 0) return null;
  let inputIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'input:sent') {
      inputIdx = i;
      break;
    }
  }
  if (inputIdx < 0) return null;
  // The server opens its own turn to run a control operation on the session:
  // `SessionManager.compact` writes `input:sent` with `source: 'command'`
  // before the provider's compaction. Nothing in that turn is the worker's
  // work, and a compaction that fails ends on synthetic assistant text that
  // reads like one of the worker's own messages — "Not enough messages to
  // compact." The same boundary
  // keeps that error out of the coordinator's reports; see
  // `worker-report-delivery.ts`.
  if ((events[inputIdx].data as { source?: string } | undefined)?.source === 'command') return null;
  const turnSeq = events[inputIdx].seq;
  const instruction = wholeOrNamed(
    String((events[inputIdx].data as { text?: unknown })?.text ?? ''),
    MESSAGE_CHARS,
    'long instruction',
  );
  if (!instruction) return null;

  const since = events.slice(inputIdx + 1);
  // The seq of the last event that put something in `work` below, not the last
  // event in the log. A worker that has only thought, or whose log grew by
  // tool results and run/permission records, is saying the same thing it was
  // saying before; assessing it again would buy the same phrase twice.
  let evidenceSeq = turnSeq;
  for (const event of since) {
    if (event.type !== 'content') continue;
    const blocks = (event.data as { blocks?: Array<Record<string, unknown>> })?.blocks ?? [];
    const contributes = blocks.some((block) => block.type === 'tool_use'
      || (block.type === 'text' && String(block.text ?? '').trim()));
    if (contributes) evidenceSeq = event.seq;
  }

  const messages: UnifiedMessage[] = eventsToUnifiedMessages(since);
  const work: string[] = [];
  for (const message of messages.slice(-EVIDENCE_MESSAGES)) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim()) {
        work.push(wholeOrNamed(block.text, MESSAGE_CHARS, 'long message'));
      } else if (block.type === 'tool_use') {
        const input = (block.input ?? {}) as Record<string, unknown>;
        const raw = [input.description, input.file_path, input.command, input.pattern]
          .find((value) => typeof value === 'string' && value) as string | undefined;
        const detail = raw ? wholeOrNamed(raw, TOOL_DETAIL_CHARS, 'long tool detail') : '';
        work.push(detail ? `${block.name}: ${detail}` : block.name);
      }
    }
  }
  return { instruction, work, turnSeq, evidenceSeq };
}

// ---------------------------------------------------------------------------
// The writer

/** The whole prompt, exported so tests can see what the writer is told. */
export function buildActivityPrompt(task: string, evidence: ActivityEvidence): { system: string; user: string } {
  const system = [
    `You write the one-line activity on a worker card, for ${userName()}. They are watching a panel of cards to see where the`,
    'work stands; they have not opened this worker and will not read its session. Say what it is doing right now.',
    '',
    'Write 2 to 5 words, present participle, no full stop: "Testing the composer", "Checking worker reports",',
    '"Fixing the sidebar".',
    `- Stay inside the words of the task below. The task was written for ${userName()}; it names the things they recognise.`,
    '  The work evidence is only there to tell you which part of the task is happening now.',
    `- Name the part of the product ${userName()} would point at, never the mechanism inside it. No file, function, identifier,`,
    '  test, commit, session, or internal step. They have not read this code today. Two real failures to avoid, both true',
    '  and both meaningless to them: "checking the final-reply boundary" (say "Checking worker reports") and "tracing the',
    '  sidebar\'s data fetch" (say "Checking the sidebar").',
    '- When the evidence does not support anything more specific, the phase alone is the right answer:',
    '  "Investigating", "Implementing", "Verifying", "Writing it up".',
    '- Describe only what is happening. No progress, no counts, no findings, no what-comes-next, no time estimates.',
    '',
    'Answer with the phrase alone.',
  ].join('\n');
  const user = [
    'The task this worker was given:',
    task,
    '',
    'What the coordinator last told it:',
    evidence.instruction,
    '',
    'What it has done since, oldest first:',
    evidence.work.length > 0 ? evidence.work.join('\n') : '(nothing yet)',
  ].join('\n');
  return { system, user };
}

/** The phrase, if the model wrote one that fits the card. */
export function usablePhrase(raw: string): string | null {
  const text = raw.replace(/\s+/g, ' ').trim().replace(/^["']|["'.]+$/g, '').trim();
  if (!text) return null;
  if (text.length > MAX_PHRASE_CHARS) return null;
  if (text.split(' ').filter(Boolean).length > MAX_PHRASE_WORDS) return null;
  return text;
}

// ---------------------------------------------------------------------------
// Scheduling

class WorkerActivityService extends EventEmitter {
  constructor() {
    super();
    // One 'changed' listener per open activity stream, as with the permission
    // tracker and the pending-question service.
    this.setMaxListeners(100);
  }

  private running = new Set<string>();
  private queued = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastRunAt = new Map<string, number>();

  /**
   * A worker's log moved. Schedules an assessment if one is due; a worker
   * already being assessed gets exactly one more when that finishes.
   */
  note(worker: string): void {
    if (this.running.has(worker)) {
      this.queued.add(worker);
      return;
    }
    if (this.timers.has(worker)) return;
    const since = Date.now() - (this.lastRunAt.get(worker) ?? 0);
    const wait = Math.max(0, MIN_GAP_MS - since);
    const timer = setTimeout(() => {
      this.timers.delete(worker);
      void this.run(worker);
    }, wait);
    timer.unref?.();
    this.timers.set(worker, timer);
  }

  private async run(worker: string): Promise<void> {
    if (this.running.has(worker)) {
      this.queued.add(worker);
      return;
    }
    this.running.add(worker);
    this.lastRunAt.set(worker, Date.now());
    try {
      await assessWorker(worker, (coordinator) => this.emit('changed', { coordinator, worker }));
    } catch (err) {
      logger.debug('Activity assessment failed', { worker, error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running.delete(worker);
      if (this.queued.delete(worker)) this.note(worker);
    }
  }

  /** Tests and shutdown: drop pending timers so nothing fires later. */
  reset(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.running.clear();
    this.queued.clear();
    this.lastRunAt.clear();
  }
}

let service: WorkerActivityService | null = null;

export function getWorkerActivityService(): WorkerActivityService {
  if (!service) service = new WorkerActivityService();
  return service;
}

/**
 * A worker's process started, stopped or died. Tells the coordinator's open
 * panel to refetch, straight away and without an assessment.
 *
 * The panel refetches on the coordinator's own worker and status events, and
 * a worker starting or ending produces none of those — its `run:end` lands in
 * its own log, not the coordinator's. So before this existed, an open panel
 * kept whatever it had last drawn: the endpoint could be entirely correct and
 * the card would still read Working at a session that had exited minutes ago,
 * until something unrelated happened to the coordinator or the user reloaded.
 *
 * Deliberately not `note()`: that debounces by MIN_GAP_MS and then spends an
 * LLM call deciding a phrase, and `assessWorker` gives up on anything whose
 * phase is not `working`. A stop has nothing to phrase — the card needs to
 * stop showing the stale one — so this only rings the bell.
 */
export function noteWorkerRuntimeChange(conversationId: string): void {
  try {
    const conversation = ConversationService.getInstance().getConversation(conversationId);
    const coordinator = conversation?.pickedUpFrom;
    if (!coordinator) return;
    getWorkerActivityService().emit('changed', { coordinator, worker: conversationId });
  } catch (err) {
    logger.debug('Runtime change note failed', { worker: conversationId, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Called from the turn side effects for every conversation; a no-op unless
 * this one is a worker and the feature is on. Never rejects.
 */
export function noteWorkerActivity(conversationId: string): void {
  if (!allowGeneration('workerActivity')) return;
  try {
    const conversation = ConversationService.getInstance().getConversation(conversationId);
    if (!conversation?.pickedUpFrom) return;
    getWorkerActivityService().note(conversationId);
  } catch (err) {
    logger.debug('Activity note failed', { worker: conversationId, error: err instanceof Error ? err.message : String(err) });
  }
}

async function assessWorker(worker: string, onChanged: (coordinator: string) => void): Promise<void> {
  if (!allowGeneration('workerActivity')) return;
  const conversationService = ConversationService.getInstance();
  const conversation = conversationService.getConversation(worker);
  const coordinator = conversation?.pickedUpFrom;
  if (!coordinator) return;

  const events = getEventStorage().readTail(worker, TAIL_EVENTS);
  const evidence = readActivityEvidence(events);
  if (!evidence) return;

  const stored = readRow(worker);
  if (stored && stored.evidence_seq >= evidence.evidenceSeq) return;

  const card = workerCard(coordinator, worker);
  // A worker that has asked or reported is not doing anything present tense;
  // its question or report is what the card shows.
  if (!card || card.phase !== 'working') return;

  const client = anthropicClientFactory.getClient();
  if (!client) {
    logger.debug('No Anthropic client; worker cards keep their lifecycle line', { worker });
    return;
  }
  const prompt = buildActivityPrompt(card.task, evidence);
  const model = activityModel();
  const started = Date.now();
  const response = await client.messages.create({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
  });
  const durationMs = Date.now() - started;
  try {
    getCostTracker().log({
      sessionId: worker,
      operation: 'WORKER_ACTIVITY',
      model,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      cacheCreationInputTokens: response.usage?.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: response.usage?.cache_read_input_tokens ?? 0,
      durationMs,
    });
  } catch (err) {
    logger.debug('Cost tracking failed', { error: err });
  }

  const phrase = usablePhrase(
    response.content.map((block) => (block.type === 'text' ? block.text : '')).join(' '),
  );
  if (!phrase) {
    logger.debug('No usable activity phrase; the card keeps its lifecycle line', { worker, model });
    return;
  }

  // The call took time. If the worker has been answered again, asked, reported
  // or stopped meanwhile, this phrase is about work that is over.
  if (!stillCurrent(worker, evidence.turnSeq)) {
    logger.debug('Activity result arrived after the turn it describes; dropped', { worker, turnSeq: evidence.turnSeq });
    return;
  }

  writeRow({
    worker,
    coordinator,
    text: phrase,
    turn_seq: evidence.turnSeq,
    evidence_seq: evidence.evidenceSeq,
    model,
    at: new Date().toISOString(),
  });
  logger.info('Worker activity written', { worker, model, ms: durationMs, text: phrase });
  onChanged(coordinator);
}

/**
 * The worker is still inside the turn the phrase was written from.
 *
 * A compaction the provider runs of its own accord writes a `turn:end` with
 * `compact: true` in the middle of a turn and the worker carries straight on
 * until the turn's real end. That boundary is not the turn ending, so the phrase it was
 * doing is still true. Everything else that closes a turn still closes it: a
 * new `input:sent`, whoever sent it and whatever its source, a stop, and the
 * turn's own real `turn:end`.
 */
export function turnStillOpen(events: readonly SessionEvent[], turnSeq: number): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.seq <= turnSeq) break;
    if (event.type === 'turn:end' && (event.data as { compact?: boolean } | undefined)?.compact === true) continue;
    if (event.type === 'input:sent' || event.type === 'stop:requested' || event.type === 'turn:end') return false;
  }
  return true;
}

function stillCurrent(worker: string, turnSeq: number): boolean {
  return turnStillOpen(getEventStorage().readTail(worker, TAIL_EVENTS), turnSeq);
}

/** The task the coordinator wrote for this worker at dispatch, and its phase now. */
function workerCard(coordinator: string, worker: string): { task: string; phase: string } | null {
  const state = readWorkerStates(coordinator).find((candidate) => candidate.worker === worker);
  return state?.task ? { task: state.task, phase: state.phase } : null;
}
