/**
 * Explain-back (`lattice explain`): an agent asks the user to explain
 * something in their own words, as a card in its own thread. The ideas a good
 * explanation contains stay hidden; Jev checks the draft at each pause in
 * typing and the card marks which ideas are there, which are partly there,
 * and which a stated misconception undoes.
 *
 * Events in that thread's log:
 *
 *   `explain:asked    { id, prompt, ideas, misconceptions }`  the card
 *   `explain:checked  { id, text, marks, flags, status, … }`  one check, and
 *                                                             what the card
 *                                                             showed after it
 *   `explain:hint     { id, idea }`                           a hint opened
 *   `explain:disputed { id, idea, text }`                     "I covered this"
 *   `explain:finished { id, passed, text, inboxId }`          the user is done;
 *                                                             the agent gets
 *                                                             one line
 *
 * The checks are the telemetry: `lattice explain log` replays them, so the
 * agent can see where the user got stuck.
 */

export const EXPLAIN_ASKED_EVENT = 'explain:asked';
export const EXPLAIN_CHECKED_EVENT = 'explain:checked';
export const EXPLAIN_HINT_EVENT = 'explain:hint';
export const EXPLAIN_DISPUTED_EVENT = 'explain:disputed';
export const EXPLAIN_FINISHED_EVENT = 'explain:finished';

export const EXPLAIN_MIN_IDEAS = 1;
export const EXPLAIN_MAX_IDEAS = 8;
export const EXPLAIN_MAX_MISCONCEPTIONS = 6;

/** Jev's score is 0 (absent) .. 2 (clearly stated). */
export const IDEA_MET = 1.4;
export const IDEA_PARTIAL = 0.75;
/** A mark already shown stays until the score falls below these, so a score sitting on a line does not flicker. */
export const IDEA_MET_KEEP = 1.2;
export const IDEA_PARTIAL_KEEP = 0.6;
/** A mark is only taken away when Jev is at least this sure, so marks do not flicker while the user types. */
export const DOWNGRADE_MIN_CONFIDENCE = 0.3;
/** A misconception flags at or above ON and clears at or below OFF; between them it keeps its state. */
export const MISCONCEPTION_ON = 0.65;
export const MISCONCEPTION_OFF = 0.35;

export interface ExplainIdea {
  id: string;
  /** Shown once the idea is touched; until then the card says "Idea N". */
  label: string;
  /** The one fact Jev looks for. Never shown on the card. */
  statement: string;
  /** A question or nudge towards the idea that does not state it. */
  hint: string;
}

export interface ExplainMisconception {
  id: string;
  /** The idea it undoes: while it is flagged, that idea shows as Revisit. */
  idea: string;
  statement: string;
  /** Shown when it is flagged: a question that makes the user look again, not the correction. */
  nudge: string;
}

export interface ExplainAskedData {
  id: string;
  prompt: string;
  ideas: ExplainIdea[];
  misconceptions: ExplainMisconception[];
}

export type IdeaMark = 'none' | 'part' | 'met';
export type ExplainStatus = 'keep-going' | 'add-more' | 'revisit' | 'demonstrated';

export interface ExplainFlag {
  id: string;
  /** The sentence that states it, when Jev could point to one. */
  sentence: string | null;
}

export interface ExplainCheckedData {
  id: string;
  text: string;
  marks: Record<string, IdeaMark>;
  /** Misconceptions flagged after this check. */
  flags: ExplainFlag[];
  status: ExplainStatus;
  /** Jev's raw answers, for tuning the thresholds later. */
  scores: Record<string, { score: number; confidence: number }>;
  misconceptionP: Record<string, number>;
  model: string;
  ms: number;
}

export interface ExplainFinishedData {
  id: string;
  passed: boolean;
  text: string;
  inboxId: string;
}

export interface ExplainState {
  asked: ExplainAskedData;
  last: ExplainCheckedData | null;
  /** Ideas whose hint the user opened, in the order they first opened them. */
  hints: string[];
  /** Ideas the user said they covered when the card did not mark them. */
  disputed: string[];
  finished: ExplainFinishedData | null;
}

/** A log event as both the server's store and the page's stream give it. */
export interface ExplainEventLike {
  type: string;
  data: unknown;
}

export function foldExplains(events: readonly ExplainEventLike[]): Map<string, ExplainState> {
  const explains = new Map<string, ExplainState>();
  for (const event of events) {
    const data = event.data as { id?: string } | undefined;
    if (!data?.id) continue;
    if (event.type === EXPLAIN_ASKED_EVENT) {
      explains.set(data.id, { asked: event.data as ExplainAskedData, last: null, hints: [], disputed: [], finished: null });
      continue;
    }
    const state = explains.get(data.id);
    if (!state) continue;
    switch (event.type) {
      case EXPLAIN_CHECKED_EVENT:
        state.last = event.data as ExplainCheckedData;
        break;
      case EXPLAIN_HINT_EVENT: {
        const idea = (event.data as { idea?: string }).idea;
        if (idea && !state.hints.includes(idea)) state.hints.push(idea);
        break;
      }
      case EXPLAIN_DISPUTED_EVENT: {
        const idea = (event.data as { idea?: string }).idea;
        if (idea && !state.disputed.includes(idea)) state.disputed.push(idea);
        break;
      }
      case EXPLAIN_FINISHED_EVENT:
        state.finished = event.data as ExplainFinishedData;
        break;
      default:
        break;
    }
  }
  return explains;
}

/** The mark Jev's score means on its own. */
export function markForScore(score: number): IdeaMark {
  return score >= IDEA_MET ? 'met' : score >= IDEA_PARTIAL ? 'part' : 'none';
}

const RANK: Record<IdeaMark, number> = { none: 0, part: 1, met: 2 };

/** The marks after a check: a mark goes down only when the score falls clearly below its line and Jev is sure. */
export function nextMarks(
  previous: Record<string, IdeaMark> | null,
  scores: Record<string, { score: number; confidence: number }>,
): Record<string, IdeaMark> {
  const marks: Record<string, IdeaMark> = {};
  for (const [id, { score, confidence }] of Object.entries(scores)) {
    const before = previous?.[id] ?? 'none';
    const kept = before === 'met' && score >= IDEA_MET_KEEP ? 'met' : before !== 'none' && score >= IDEA_PARTIAL_KEEP ? 'part' : 'none';
    const next = RANK[kept] > RANK[markForScore(score)] ? kept : markForScore(score);
    marks[id] = RANK[next] < RANK[before] && confidence < DOWNGRADE_MIN_CONFIDENCE ? before : next;
  }
  return marks;
}

/** The misconceptions flagged after a check: on at ON, off at OFF, unchanged between. */
export function nextFlags(
  previous: readonly ExplainFlag[],
  results: readonly { id: string; p: number; sentence: string | null }[],
): ExplainFlag[] {
  const flags: ExplainFlag[] = [];
  for (const result of results) {
    const was = previous.find((flag) => flag.id === result.id);
    if (result.p >= MISCONCEPTION_ON) flags.push({ id: result.id, sentence: result.sentence ?? was?.sentence ?? null });
    else if (result.p > MISCONCEPTION_OFF && was) flags.push(was);
  }
  return flags;
}

/** What an idea shows: Revisit while a misconception about it is flagged, otherwise its mark. */
export function shownMark(asked: ExplainAskedData, marks: Record<string, IdeaMark>, flags: readonly ExplainFlag[], ideaId: string): IdeaMark | 'revisit' {
  const undone = flags.some((flag) => asked.misconceptions.find((m) => m.id === flag.id)?.idea === ideaId);
  return undone ? 'revisit' : marks[ideaId] ?? 'none';
}

export function explainStatus(asked: ExplainAskedData, marks: Record<string, IdeaMark>, flags: readonly ExplainFlag[]): ExplainStatus {
  if (flags.length > 0) return 'revisit';
  const shown = asked.ideas.map((idea) => marks[idea.id] ?? 'none');
  if (shown.every((mark) => mark === 'met')) return 'demonstrated';
  if (shown.some((mark) => mark !== 'none')) return 'add-more';
  return 'keep-going';
}

export const STATUS_TEXT: Record<ExplainStatus, string> = {
  'keep-going': 'Keep going',
  'add-more': 'Add more detail',
  revisit: 'Revisit an idea',
  demonstrated: 'Understanding demonstrated',
};

/** The explanation split into sentences, as Jev is asked to point at one. A line break ends a sentence too. */
export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\s*\n\s*/).map((sentence) => sentence.trim()).filter(Boolean);
}

const THINKING_BLOCKS = new Set(['thinking', 'redacted_thinking', 'reasoning']);

/**
 * The thread's events with the agent's reasoning taken out of each turn that
 * posted an explain-back still open: an agent writing a rubric reasons about
 * the very ideas the card hides, and the thread shows reasoning by default.
 * Once the user finishes the card, the reasoning shows again.
 */
export function concealOpenExplainReasoning<E extends { type: string; data?: unknown }>(events: readonly E[]): readonly E[] {
  if (!events.some((event) => event.type === EXPLAIN_ASKED_EVENT)) return events;
  const finished = new Set<string>();
  for (const event of events) if (event.type === EXPLAIN_FINISHED_EVENT) finished.add((event.data as { id?: string })?.id ?? '');

  const concealed = new Set<number>();
  events.forEach((event, i) => {
    if (event.type !== EXPLAIN_ASKED_EVENT || finished.has((event.data as { id?: string })?.id ?? '')) return;
    for (let j = i - 1; j >= 0 && events[j].type !== 'input:sent'; j -= 1) concealed.add(j);
    for (let j = i + 1; j < events.length && !['turn:end', 'run:end', 'run:error'].includes(events[j].type); j += 1) concealed.add(j);
  });
  if (concealed.size === 0) return events;

  return events.map((event, i) => {
    if (!concealed.has(i) || event.type !== 'content') return event;
    const data = event.data as { blocks?: Array<{ type?: string }> } | undefined;
    if (!data?.blocks?.some((block) => THINKING_BLOCKS.has(block.type ?? ''))) return event;
    return { ...event, data: { ...data, blocks: data.blocks.filter((block) => !THINKING_BLOCKS.has(block.type ?? '')) } };
  });
}
