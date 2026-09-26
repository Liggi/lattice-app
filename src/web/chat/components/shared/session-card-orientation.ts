/**
 * What the card says a session exists to accomplish, and what determines the
 * reader's relationship to it now.
 *
 * Two sources, deliberately ranked:
 *
 * - Argus's ambient read: a stable purpose plus a separately refreshed state.
 * - The session mission from insights, frozen near session start and regenerated
 *   rarely.
 *
 * Argus wins when present because it can preserve the user-approved assignment
 * through ordinary progress and update it after a genuine redirect. The state
 * line has a shorter horizon: it follows runtime ownership, blockers, and
 * meaningful checkpoints. Where no read exists, the insight mission remains
 * the best available fallback.
 *
 * Kept as plain functions so the ranking is testable without rendering a card.
 */

import type { AmbientRead, ArrowKind } from '../AmbientPortfolio/ambient-types';

export interface CardOrientation {
  /**
   * The single line describing the session, and which source produced it. The
   * card renders this as its title — there is no second description block.
   */
  description: { text: string; source: 'ambient' | 'insights' } | null;
  /** The "what happens next" line. Only ambient produces one. */
  arrow: { kind: ArrowKind; text: string } | null;
}

/**
 * Only a reply-shaped `your-move` is answered by sending into the session. A
 * `your-move` with no suggested reply happens somewhere else (open a link,
 * share a document, test a device), while `working` and `waiting-on` report
 * state owned elsewhere. A message does not by itself settle those arrows.
 */
function messageAnswersArrow(read: AmbientRead, kind: ArrowKind): boolean {
  return kind === 'your-move' && Boolean(read.suggestedNext?.trim());
}

/**
 * `nothing-pending` is deliberately dropped rather than rendered. It means the
 * thread is finished with nothing outstanding, which is what a card with no
 * arrow already communicates — printing it spends a line to say nothing.
 *
 * An arrow is also dropped once the reader has sent into the session more
 * recently than the boundary the read was computed from. The scan reruns on the
 * `input:sent` boundary that same send creates, so this only covers the gap
 * until it lands — but that gap is a card telling the user to reply to a message
 * they have already replied to.
 */
function selectArrow(
  read: AmbientRead | null | undefined,
  userSentAt: number | null | undefined,
): CardOrientation['arrow'] {
  const arrow = read?.arrow;
  if (!arrow) return null;
  const text = arrow.text?.trim();
  if (!text) return null;
  if (arrow.kind === 'nothing-pending') return null;
  // A read with no boundary predates the field entirely, so there is nothing to
  // compare against; treat any send as newer. Erring towards a missing arrow
  // over a stale one is the whole point of this rule.
  const boundaryTs = read?.sourceBoundaryTs ?? 0;
  if (userSentAt && userSentAt > boundaryTs && messageAnswersArrow(read, arrow.kind)) return null;
  return { kind: arrow.kind, text };
}

export function resolveCardOrientation(input: {
  ambientRead?: AmbientRead | null;
  /** The insight-derived mission, used when there is no ambient read. */
  mission?: string | null;
  /**
   * When the reader last sent input into this session, from `user-send-marks`.
   * Clears a reply-shaped arrow the send has already answered.
   */
  userSentAt?: number | null;
}): CardOrientation {
  const ambientContext = input.ambientRead?.context?.trim();
  const mission = input.mission?.trim();

  const description: CardOrientation['description'] = ambientContext
    ? { text: ambientContext, source: 'ambient' }
    : mission
      ? { text: mission, source: 'insights' }
      : null;

  return { description, arrow: selectArrow(input.ambientRead, input.userSentAt) };
}

/**
 * The title a card shows, in the order the sources outrank each other.
 *
 * 1. A name the user typed. An explicit instruction about the label.
 * 2. A project's generated name, written from the outcome its coordinator
 *    agreed. Only projects have one.
 * 3. Whatever the transcript says the work is — Argus's read, else the
 *    insight mission.
 * 4. The id, when nothing else exists yet.
 *
 * Two and three are in that order because they answer different questions.
 * The transcript sources say what is happening now, which is what a session
 * is; a project outlives the task in front of it, so a title taken from the
 * task renames it every few hours while the project itself has not changed.
 *
 * The first two ranks are also what makes the naming race unloseable. A
 * generated name is stored in its own field, so a generation that started
 * before the user renamed the project and finished after it cannot overwrite
 * anything — it lands in `projectName` and this function never reads it.
 */
export function resolveCardTitle(input: {
  customName?: string | null;
  projectName?: string | null;
  description?: CardOrientation['description'];
  conversationId: string;
}): string {
  return input.customName?.trim()
    || input.projectName?.trim()
    || input.description?.text?.trim()
    || input.conversationId.slice(0, 8);
}

/**
 * Arrow presentation. Colour lives on the label only — no border, no fill. A
 * card is already a bordered box; a bordered chip inside it reads as nesting,
 * and a sidebar of tinted panels reads as a wall of alerts. `your-move` is the
 * only kind that asks anything of the reader, so it gets the attention colour
 * and the others stay quiet.
 */
export const ARROW_PRESENTATION: Record<Exclude<ArrowKind, 'nothing-pending'>, {
  label: string;
  labelClassName: string;
}> = {
  'your-move': { label: 'Your move', labelClassName: 'text-amber-400/90' },
  'waiting-on': { label: 'Waiting on', labelClassName: 'text-teal-400/70' },
  working: { label: 'Working', labelClassName: 'text-muted-foreground/50' },
};
