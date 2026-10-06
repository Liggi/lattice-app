/**
 * `lattice explain`: an agent asks the user to explain something in their
 * own words, as a card in its own thread. The agent writes the rubric (the
 * ideas a good explanation contains, a hint for each, the misconceptions to
 * watch for); Jev checks the user's draft against it at each pause in their
 * typing; the user's finish hands the agent one line with how it went. Every
 * check is an event in the thread's log, which is what `lattice explain log`
 * replays. See `types/explain.ts` for the events and the fold.
 *
 * The version of Jev is pinned: the thresholds in `types/explain.ts` were
 * tuned against it on 2026-10-05, and `jev-latest` can move under them.
 */

import { randomUUID } from 'node:crypto';
import { getHarnessSessionManager } from '../../harness/setup.js';
import { appendCustomHarnessEvent } from '../../harness/harness-custom-events.js';
import { getEvents } from '../../session-history/repository.js';
import {
  EXPLAIN_ASKED_EVENT,
  EXPLAIN_CHECKED_EVENT,
  EXPLAIN_DISPUTED_EVENT,
  EXPLAIN_FINISHED_EVENT,
  EXPLAIN_HINT_EVENT,
  EXPLAIN_MAX_IDEAS,
  EXPLAIN_MAX_MISCONCEPTIONS,
  EXPLAIN_MIN_IDEAS,
  STATUS_TEXT,
  explainStatus,
  foldExplains,
  nextFlags,
  nextMarks,
  shownMark,
  splitSentences,
  type ExplainAskedData,
  type ExplainCheckedData,
  type ExplainFinishedData,
  type ExplainState,
} from '../../types/explain.js';
import { askJev, isTypeSafeConfigured, TypeSafeUnavailableError, type JevQuestion } from '../infrastructure/typesafe-client.js';
import { ConversationService } from './conversation-service.js';
import { isWorker, WORKER_ASK_REFUSAL } from './decisions.js';
import { enqueueInboxItem } from './session-inbox.js';
import { handOverNow } from './immediate-delivery.js';
import { UserName } from '../user-profile.js';
import { latticeCli } from './pickup-prompts.js';

export const EXPLAIN_JEV_MODEL = 'jev-1.13.0';
/** A check is about 300ms; the ceiling leaves room for the tail without leaving the card on "Checking…". */
const CHECK_TIMEOUT_MS = 8000;
/** A hint at or above this states its idea rather than pointing at it (two leaky hints scored 0.87 and 0.92, real ones 0.82 at most). */
const HINT_GIVES_AWAY = 0.85;

export class ExplainError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const SCORE_LEVELS = [
  'The explanation does not state this idea or anything equivalent to it.',
  'The explanation gestures at this idea vaguely, or states only part of it.',
  'The explanation clearly states this idea, in any wording.',
];

export interface ExplainRubric {
  prompt: string;
  ideas: { id: string; label: string; statement: string; hint: string }[];
  misconceptions: { idea: string; statement: string; nudge: string }[];
}

function requireManager() {
  const manager = getHarnessSessionManager();
  if (!manager) throw new Error('No harness session manager');
  return manager;
}

function explainsIn(threadId: string): Map<string, ExplainState> {
  return foldExplains(getEvents(threadId, {
    types: [EXPLAIN_ASKED_EVENT, EXPLAIN_CHECKED_EVENT, EXPLAIN_HINT_EVENT, EXPLAIN_DISPUTED_EVENT, EXPLAIN_FINISHED_EVENT],
  }));
}

function requireExplain(threadId: string, id: string): ExplainState {
  const state = explainsIn(threadId).get(id);
  if (!state) throw new ExplainError('That explain-back is not in this thread.', 404);
  return state;
}

function requireOpen(threadId: string, id: string): ExplainState {
  const state = requireExplain(threadId, id);
  if (state.finished) throw new ExplainError('That explain-back is finished.', 409);
  return state;
}

/** Refuses what the card cannot use: the reason is written for the agent that asked. */
function checkRubric(rubric: ExplainRubric): void {
  const text = (value: unknown) => typeof value === 'string' && value.trim() !== '';
  if (!text(rubric.prompt)) throw new ExplainError('The rubric has no prompt: the question the user explains.', 400);
  if (!Array.isArray(rubric.ideas) || rubric.ideas.length < EXPLAIN_MIN_IDEAS || rubric.ideas.length > EXPLAIN_MAX_IDEAS) {
    throw new ExplainError(`A rubric has ${EXPLAIN_MIN_IDEAS} to ${EXPLAIN_MAX_IDEAS} ideas.`, 400);
  }
  const ids = new Set<string>();
  for (const [n, idea] of rubric.ideas.entries()) {
    for (const field of ['id', 'label', 'statement', 'hint'] as const) {
      if (!text(idea?.[field])) throw new ExplainError(`Idea ${n + 1} has no ${field}.`, 400);
    }
    if (ids.has(idea.id)) throw new ExplainError(`Two ideas are both "${idea.id}".`, 400);
    ids.add(idea.id);
  }
  const misconceptions = rubric.misconceptions ?? [];
  if (!Array.isArray(misconceptions) || misconceptions.length > EXPLAIN_MAX_MISCONCEPTIONS) {
    throw new ExplainError(`A rubric has at most ${EXPLAIN_MAX_MISCONCEPTIONS} misconceptions.`, 400);
  }
  for (const [n, misconception] of misconceptions.entries()) {
    for (const field of ['idea', 'statement', 'nudge'] as const) {
      if (!text(misconception?.[field])) throw new ExplainError(`Misconception ${n + 1} has no ${field}.`, 400);
    }
    if (!ids.has(misconception.idea)) throw new ExplainError(`Misconception ${n + 1} names idea "${misconception.idea}", which the rubric does not have.`, 400);
  }
}

/** Hints that state their idea: repeating one would mark the idea without any understanding. */
async function hintsThatGiveAway(rubric: ExplainRubric, sessionId: string): Promise<string[]> {
  const verdicts = await Promise.all(rubric.ideas.map(async (idea) => {
    const { answers } = await askJev({ question: rubric.prompt, idea: idea.statement, hint: idea.hint }, {
      gives: {
        type: 'noul',
        instructions: { question: 'Does `hint` give away `idea`, so that someone could repeat the hint and have stated the idea without understanding it?' },
        criteria: { true: 'The hint states the idea or its key fact outright.', false: 'The hint only points towards the idea, as a question or a nudge, without stating it.' },
      },
    }, { timeoutMs: CHECK_TIMEOUT_MS, model: EXPLAIN_JEV_MODEL, cost: { operation: 'EXPLAIN_BACK', sessionId } });
    return (answers.gives.noul ?? 0) >= HINT_GIVES_AWAY ? idea.id : null;
  }));
  return verdicts.filter((id): id is string => id !== null);
}

/** Puts the card in the agent's thread. */
export async function askExplain(threadId: string, rubric: ExplainRubric): Promise<{ id: string }> {
  const manager = requireManager();
  if (!ConversationService.getInstance().getConversation(threadId)) throw new ExplainError(`No conversation ${threadId}`, 404);
  if (isWorker(threadId)) throw new ExplainError(WORKER_ASK_REFUSAL, 409);
  if (!isTypeSafeConfigured()) {
    throw new ExplainError('Explain-back checks answers with TypeSafe\'s Jev, and no TypeSafe key is configured. Set typesafe.apiKey (or typesafe.apiKeyFile) in config.json, or TYPESAFE_API_KEY.', 503);
  }
  checkRubric(rubric);

  let leaky: string[];
  try {
    leaky = await hintsThatGiveAway(rubric, threadId);
  } catch (err) {
    if (err instanceof TypeSafeUnavailableError) throw new ExplainError(`The hints could not be checked: ${err.message}. Nothing was posted.`, 502);
    throw err;
  }
  if (leaky.length > 0) {
    const named = leaky.map((id) => `"${rubric.ideas.find((idea) => idea.id === id)?.hint}" (idea ${id})`).join(', ');
    throw new ExplainError(`These hints state their idea, so repeating one would mark it: ${named}. Rewrite each as a question or nudge that points towards the idea without saying it. Nothing was posted.`, 400);
  }

  const data: ExplainAskedData = {
    id: randomUUID(),
    prompt: rubric.prompt.trim(),
    ideas: rubric.ideas.map((idea) => ({ id: idea.id.trim(), label: idea.label.trim(), statement: idea.statement.trim(), hint: idea.hint.trim() })),
    misconceptions: (rubric.misconceptions ?? []).map((m, n) => ({ id: `m${n + 1}`, idea: m.idea.trim(), statement: m.statement.trim(), nudge: m.nudge.trim() })),
  };
  if (!appendCustomHarnessEvent(manager, threadId, EXPLAIN_ASKED_EVENT, data)) {
    throw new Error(`The explain-back could not be written to ${threadId}`);
  }
  return { id: data.id };
}

function checkQuestions(asked: ExplainAskedData, sentences: string[]): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  for (const idea of asked.ideas) {
    questions[`idea:${idea.id}`] = {
      type: 'score',
      instructions: { idea: idea.statement, question: 'How fully does `explanation` express `idea`? Judge the meaning, not the wording.' },
      criteria: SCORE_LEVELS,
    };
  }
  for (const m of asked.misconceptions) {
    questions[`mis:${m.id}`] = {
      type: 'noul',
      instructions: { misconception: m.statement, question: 'Does `explanation` state or clearly imply `misconception`?' },
      criteria: { true: 'The explanation asserts the misconception or something that means the same.', false: 'The explanation does not assert it, or contradicts it.' },
    };
    if (sentences.length > 1) {
      questions[`where:${m.id}`] = {
        type: 'choice',
        instructions: { misconception: m.statement, question: 'Which sentence of the explanation states or implies `misconception`?' },
        criteria: Object.fromEntries<string>([...sentences.map((sentence, i): [string, string] => [`s${i}`, sentence]), ['none', 'No sentence states it.']]),
      };
    }
  }
  return questions;
}

/** Checks run one at a time per card, so each builds on the marks of the one before. */
const checkQueues = new Map<string, Promise<unknown>>();

/** Checks the user's draft, records what the card shows after it, and returns that. */
export function checkExplain(threadId: string, id: string, rawText: string): Promise<ExplainCheckedData> {
  const key = `${threadId}:${id}`;
  const run = (checkQueues.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => runCheck(threadId, id, rawText));
  checkQueues.set(key, run);
  void run.finally(() => {
    if (checkQueues.get(key) === run) checkQueues.delete(key);
  }).catch(() => undefined);
  return run;
}

async function runCheck(threadId: string, id: string, rawText: string): Promise<ExplainCheckedData> {
  const manager = requireManager();
  const state = requireOpen(threadId, id);
  const text = rawText.trim();
  if (!text) throw new ExplainError('There is nothing to check yet.', 400);
  if (state.last?.text === text) return state.last;
  const { asked } = state;
  const sentences = splitSentences(text);

  let result: Awaited<ReturnType<typeof askJev>>;
  try {
    result = await askJev({ question: asked.prompt, explanation: text }, checkQuestions(asked, sentences), {
      timeoutMs: CHECK_TIMEOUT_MS,
      model: EXPLAIN_JEV_MODEL,
      cost: { operation: 'EXPLAIN_BACK', sessionId: threadId },
    });
  } catch (err) {
    if (err instanceof TypeSafeUnavailableError) throw new ExplainError(err.message, 502);
    throw err;
  }
  const { answers } = result;

  const scores = Object.fromEntries(asked.ideas.map((idea) => {
    const answer = answers[`idea:${idea.id}`];
    return [idea.id, { score: answer.score ?? 0, confidence: answer.confidence ?? 0 }];
  }));
  const misconceptionP: Record<string, number> = {};
  const results = asked.misconceptions.map((m) => {
    const p = answers[`mis:${m.id}`].noul ?? 0;
    misconceptionP[m.id] = p;
    const where = answers[`where:${m.id}`]?.choice;
    const index = sentences.length === 1 ? 0 : where && where !== 'none' ? Number(where.slice(1)) : null;
    return { id: m.id, p, sentence: index === null ? null : sentences[index] ?? null };
  });

  const marks = nextMarks(state.last?.marks ?? null, scores);
  const flags = nextFlags(state.last?.flags ?? [], results);
  const checked: ExplainCheckedData = {
    id,
    text,
    marks,
    flags,
    status: explainStatus(asked, marks, flags),
    scores,
    misconceptionP,
    model: result.model,
    ms: result.ms,
  };
  appendCustomHarnessEvent(manager, threadId, EXPLAIN_CHECKED_EVENT, checked);
  return checked;
}

export function noteHintOpened(threadId: string, id: string, idea: string): void {
  const state = requireOpen(threadId, id);
  if (!state.asked.ideas.some((i) => i.id === idea)) throw new ExplainError(`No idea "${idea}" on that card.`, 400);
  if (state.hints.includes(idea)) return;
  appendCustomHarnessEvent(requireManager(), threadId, EXPLAIN_HINT_EVENT, { id, idea });
}

/** "I covered this": the user says their explanation has an idea the card did not mark. Kept for review, not acted on. */
export function disputeIdea(threadId: string, id: string, idea: string, text: string): void {
  const state = requireOpen(threadId, id);
  if (!state.asked.ideas.some((i) => i.id === idea)) throw new ExplainError(`No idea "${idea}" on that card.`, 400);
  appendCustomHarnessEvent(requireManager(), threadId, EXPLAIN_DISPUTED_EVENT, { id, idea, text: text.trim() });
}

const MARK_WORDS = { met: 'got it', part: 'partly there', none: 'missing', revisit: 'undone by a misconception' } as const;

/** The line the agent reads when the user finishes. */
export function finishLine(threadId: string, state: ExplainState, passed: boolean, text: string): string {
  const { asked, last } = state;
  const marks = last?.marks ?? {};
  const flags = last?.flags ?? [];
  const met = asked.ideas.filter((idea) => marks[idea.id] === 'met').length;
  const lines = [
    passed
      ? `${UserName()} finished your explain-back "${asked.prompt}": understanding demonstrated.`
      : `${UserName()} stopped your explain-back "${asked.prompt}" before demonstrating it: ${met} of ${asked.ideas.length} ideas got it.`,
  ];
  for (const idea of asked.ideas) {
    const notes = [
      state.hints.includes(idea.id) ? 'opened the hint' : null,
      state.disputed.includes(idea.id) ? 'said they covered it' : null,
    ].filter(Boolean);
    lines.push(`- ${idea.label}: ${MARK_WORDS[shownMark(asked, marks, flags, idea.id)]}${notes.length ? ` (${notes.join(', ')})` : ''}`);
  }
  for (const flag of flags) {
    const misconception = asked.misconceptions.find((m) => m.id === flag.id);
    if (misconception) lines.push(`- Still flagged: ${misconception.statement}${flag.sentence ? ` In: "${flag.sentence}"` : ''}`);
  }
  lines.push(text ? `Their explanation: ${text}` : 'They wrote nothing.');
  lines.push(`How they got there: \`${latticeCli()} explain log --session ${threadId} --id ${asked.id}\``);
  return lines.join('\n');
}

/**
 * The user is done, whether the card says they demonstrated it or not. A
 * draft typed after the last check is checked first, so the agent hears
 * about what the user actually wrote.
 */
export async function finishExplain(threadId: string, id: string, rawText: string): Promise<ExplainFinishedData> {
  const manager = requireManager();
  const text = rawText.trim();
  let state = requireOpen(threadId, id);
  if (text && state.last?.text !== text) {
    await checkExplain(threadId, id, text);
    state = requireOpen(threadId, id);
  }
  const passed = state.last?.status === 'demonstrated' && Boolean(text);
  const inboxId = enqueueInboxItem({ sessionId: threadId, source: 'explain', text: finishLine(threadId, state, passed, text) });
  const data: ExplainFinishedData = { id, passed, text, inboxId };
  appendCustomHarnessEvent(manager, threadId, EXPLAIN_FINISHED_EVENT, data);
  await handOverNow(threadId, inboxId);
  return data;
}

const MARK_GLYPH = { met: '✓', part: '~', revisit: '!', none: '–' } as const;

/**
 * A card's attempt as a timeline: each change in what the card showed, with
 * the user's draft at that moment, the hints and disputes between, and runs
 * of checks that changed nothing folded into one line.
 */
export function explainTimeline(threadId: string, id?: string): string {
  const events = getEvents(threadId, {
    types: [EXPLAIN_ASKED_EVENT, EXPLAIN_CHECKED_EVENT, EXPLAIN_HINT_EVENT, EXPLAIN_DISPUTED_EVENT, EXPLAIN_FINISHED_EVENT],
  });
  const asked = events.filter((event) => event.type === EXPLAIN_ASKED_EVENT).map((event) => event.data as ExplainAskedData);
  if (asked.length === 0) throw new ExplainError(`No explain-backs in ${threadId}.`, 404);
  const chosen = id ? asked.find((card) => card.id === id) : asked.at(-1);
  if (!chosen) throw new ExplainError(`No explain-back ${id} in ${threadId}.`, 404);

  const mine = events.filter((event) => (event.data as { id?: string })?.id === chosen.id);
  const time = (event: { timestamp: unknown }) => new Date(event.timestamp as number | string).getTime();
  const start = time(mine[0]);
  const at = (event: { timestamp: unknown }) => `+${Math.round((time(event) - start) / 1000)}s`.padStart(7);
  const label = (ideaId: string) => chosen.ideas.find((idea) => idea.id === ideaId)?.label ?? ideaId;

  const lines = [`Explain-back ${chosen.id}: "${chosen.prompt}"`, `Ideas: ${chosen.ideas.map((idea) => `${idea.id} (${idea.label})`).join(', ')}`, ''];
  if (asked.length > 1 && !id) lines.splice(1, 0, `(the latest of ${asked.length} in this thread; earlier ones: ${asked.slice(0, -1).map((card) => card.id).join(', ')})`);
  let lastShown = '';
  // Checks since the card last changed what it showed: the user typing without moving any mark.
  const unchanged = { since: 0, count: 0 };
  const flushUnchanged = (until: number) => {
    if (unchanged.count > 0) lines.push(`           (no change through ${unchanged.count} more check${unchanged.count === 1 ? '' : 's'}; stuck ${Math.round((until - unchanged.since) / 1000)}s)`);
    unchanged.count = 0;
  };
  for (const event of mine) {
    const when = time(event);
    switch (event.type) {
      case EXPLAIN_ASKED_EVENT:
        lines.push(`${at(event)}  card posted`);
        break;
      case EXPLAIN_CHECKED_EVENT: {
        const data = event.data as ExplainCheckedData;
        const shown = chosen.ideas.map((idea) => `${MARK_GLYPH[shownMark(chosen, data.marks, data.flags, idea.id)]}${idea.id}`).join(' ');
        const summary = `${shown}  ${STATUS_TEXT[data.status]}`;
        if (summary === lastShown) {
          unchanged.count += 1;
          break;
        }
        flushUnchanged(when);
        lines.push(`${at(event)}  ${summary}`);
        for (const flag of data.flags) {
          const misconception = chosen.misconceptions.find((m) => m.id === flag.id);
          lines.push(`           flagged: ${misconception?.statement ?? flag.id}${flag.sentence ? ` In: "${flag.sentence}"` : ''}`);
        }
        lines.push(`           draft: ${data.text.replace(/\s+/g, ' ')}`);
        lastShown = summary;
        unchanged.since = when;
        break;
      }
      case EXPLAIN_HINT_EVENT:
        flushUnchanged(when);
        lines.push(`${at(event)}  opened the hint for ${label((event.data as { idea: string }).idea)}`);
        break;
      case EXPLAIN_DISPUTED_EVENT:
        flushUnchanged(when);
        lines.push(`${at(event)}  said they covered ${label((event.data as { idea: string }).idea)}`);
        break;
      case EXPLAIN_FINISHED_EVENT:
        flushUnchanged(when);
        lines.push(`${at(event)}  finished: ${(event.data as ExplainFinishedData).passed ? 'understanding demonstrated' : 'stopped before demonstrating it'}`);
        break;
      default:
        break;
    }
  }
  if (unchanged.count > 0) lines.push(`           (no change through ${unchanged.count} more check${unchanged.count === 1 ? '' : 's'} to the end of the log)`);
  return lines.join('\n');
}
