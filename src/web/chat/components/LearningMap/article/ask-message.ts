/**
 * The message an inline highlight→ask sends to the responder session.
 *
 * The responder is an ordinary Lattice session with no knowledge of the map, so
 * everything it needs to answer has to be in the text: which article, which map,
 * which span, and the fact that the reply is going to be rendered as marginalia
 * rather than read in a chat transcript.
 *
 * Kept pure and separate so the exact wording is pinned by a test — this string
 * is the whole interface between the article surface and the agent.
 */

export interface AskMessageInput {
  articleTitle: string;
  mapName: string;
  /** The highlighted span, never truncated. */
  quote: string;
  question: string;
}

/**
 * Tells the agent what shape the answer needs to take. Separate export so the
 * test asserts against one copy of the sentence rather than repeating it.
 */
export const ANSWER_STYLE_SENTENCE =
  'Answer concisely in markdown — this is rendered as a margin note beside the '
  + 'highlighted span, not as a chat reply.';

export function buildAskMessage(input: AskMessageInput): string {
  const { articleTitle, mapName, quote, question } = input;
  return `In the article "${articleTitle}" on learning map "${mapName}", `
    + `about the highlighted span "${quote}": ${question}`
    + `\n\n${ANSWER_STYLE_SENTENCE}`;
}
