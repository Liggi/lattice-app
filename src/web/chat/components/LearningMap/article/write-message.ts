/**
 * The message that asks a session to write the article at the end of a follow.
 *
 * The session has no knowledge of the map, so the whole brief has to be in the
 * text: which article the reader came from, what they asked, the article they
 * were reading in full, and what shape the reply has to take.
 *
 * The bolding rule is the load-bearing part. Bold text in an article is the
 * index the tooltip generator works from — `extractBoldConcepts` treats every
 * `**term**` as a concept worth explaining, and the "Tell me more" affordance
 * hangs off the same terms. A model that bolds for emphasis produces tooltips
 * explaining "very important", so the instruction says what bold *means* here
 * rather than asking for it stylistically.
 *
 * `marker` is the first line, and it is what the answer is found by: the
 * harness echoes a sent message back as a user message, and matching a whole
 * multi-kilobyte brief against that echo is a lot to bet on. The first line
 * already names the article and the question, so it identifies this turn on its
 * own. Kept pure and separate from the hook so both strings are pinned by test.
 */

export interface WriteMessageInput {
  mapName: string;
  /** The article the reader was in when they asked. */
  parentTitle: string;
  /** That article's whole body. Never truncated. */
  parentContent: string;
  /** The bold term they asked about — the new article's subject and title. */
  concept: string;
  question: string;
}

/** What the finished article has to look like. One copy, asserted by test. */
export const WRITE_STYLE_SENTENCES =
  'Reply with the article itself and nothing else: no preamble, no sign-off, no '
  + 'fenced block around the whole thing, and no title heading — the article is '
  + 'already titled. A few short paragraphs of markdown is the right length.'
  + '\n\nBold every term a reader might want explained next, and bold nothing '
  + 'else. In this app bold means "this is a term worth its own article", never '
  + 'emphasis: each bold term gets a generated hover explanation and its own '
  + '"tell me more" link, so a word bolded for emphasis becomes a junk tooltip.';

export interface WriteMessage {
  /** The line the answer is located by in the responder's transcript. */
  marker: string;
  /** The whole brief, beginning with `marker`. */
  message: string;
}

export function buildWriteMessage(input: WriteMessageInput): WriteMessage {
  const { mapName, parentTitle, parentContent, concept, question } = input;

  const marker = `Reading "${parentTitle}" on learning map "${mapName}", `
    + `I asked: ${question}`;

  const message = `${marker}\n\n`
    + `Write the article that answers it. Its subject is "${concept}", and it `
    + 'goes on the same map directly after the article I was reading, so it '
    + 'should carry on from that rather than repeat it. That article, in full:'
    + `\n\n---\n${parentContent}\n---\n\n`
    + WRITE_STYLE_SENTENCES;

  return { marker, message };
}
