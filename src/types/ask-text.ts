/**
 * Reading a thread's `--ask` (2026-10-11, thread 39148). Coordinators write
 * it as free text; the light convention is a short context, then numbered
 * questions, each ending "Recommendation: <a few words>". The panel lays a
 * numbered ask out as questions answered in place and shows any other ask
 * as written. Lattice refuses an ask too long to take in at a glance,
 * because the panel never truncates.
 */

export interface AskQuestion {
  text: string;
  recommendation: string | null;
}

export interface ParsedAsk {
  context: string;
  questions: AskQuestion[];
}

export const ASK_CONTEXT_MAX = 240;
export const ASK_QUESTION_MAX = 160;
export const ASK_RECOMMENDATION_MAX = 60;

const RECOMMENDATION = /\s*Recommend(?:ation|ed)?:\s*(.+?)\.?\s*$/is;

/**
 * The numbered questions, on their own lines or run together ("… 1. A? 2.
 * B?"), counted from 1 in order so a stray "2." inside a sentence does not
 * split one. Null when there are fewer than two.
 */
export function parseAsk(text: string): ParsedAsk | null {
  const marks: { at: number; end: number }[] = [];
  const pattern = /(^|\s)(\d{1,2})[.)]\s+/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (Number(match[2]) !== marks.length + 1) continue;
    marks.push({ at: match.index + match[1].length, end: match.index + match[0].length });
  }
  if (marks.length < 2) return null;
  const questions = marks.map((mark, i) => {
    const body = text.slice(mark.end, marks[i + 1]?.at ?? text.length).replace(/\s+/g, ' ').trim();
    const rec = body.match(RECOMMENDATION);
    return rec
      ? { text: body.slice(0, rec.index).trim(), recommendation: rec[1].trim().replace(/^./, (c) => c.toUpperCase()) }
      : { text: body, recommendation: null };
  });
  // A closing "Five questions:" announces the list below it; the list says it.
  const context = text.slice(0, marks[0].at).trim().replace(/(^|[.!?])\s*[^.!?]*:$/, '$1').trim();
  return { context, questions };
}

/** Why an ask is too long to read at a glance, with how to shorten it; null when it is fine. */
export function askTooLong(text: string): string | null {
  const parsed = parseAsk(text);
  const how = 'The context is one or two sentences; each question is one sentence, with detail only where it changes the answer, '
    + 'on its own numbered line ending "Recommendation: <a few words>".';
  if (!parsed) {
    return text.length > ASK_CONTEXT_MAX + ASK_QUESTION_MAX
      ? `the ask is ${text.length} characters, the most for one without numbered questions is ${ASK_CONTEXT_MAX + ASK_QUESTION_MAX}. ${how}`
      : null;
  }
  if (parsed.context.length > ASK_CONTEXT_MAX) return `the ask's context is ${parsed.context.length} characters, the most is ${ASK_CONTEXT_MAX}. ${how}`;
  for (const [i, q] of parsed.questions.entries()) {
    if (q.text.length > ASK_QUESTION_MAX) return `question ${i + 1} of the ask is ${q.text.length} characters, the most is ${ASK_QUESTION_MAX}. ${how}`;
    if (q.recommendation && q.recommendation.length > ASK_RECOMMENDATION_MAX) {
      return `the recommendation on question ${i + 1} is ${q.recommendation.length} characters, the most is ${ASK_RECOMMENDATION_MAX}: the answer in a few words, with the reason in the question. ${how}`;
    }
  }
  return null;
}

/** What the user sends back: each question's number and answer, a line each. */
export function askAnswers(questions: readonly AskQuestion[], answers: readonly (string | null)[]): string {
  return questions.map((q, i) => `${i + 1}. ${answers[i]?.trim() || q.recommendation || 'No answer'}`).join('\n');
}
