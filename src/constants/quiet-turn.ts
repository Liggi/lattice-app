/**
 * What a coordinator writes to end a turn that has nothing for the user.
 * Models told to end with no text often write a line about the silence
 * instead ("(no text)"), so the preamble gives them this to write and the
 * thread drops it like blank text.
 */
export const QUIET_TURN_MARKER = 'NO_REPLY';

/**
 * Gemini sometimes glues a stray token of up to 3 capital letters onto the marker ("NO_REPLYCP", 24 Nov 2026,
 * stored that way in agy's own record), then copies it in later turns.
 */
const QUIET_TURN_PART = new RegExp(`^${QUIET_TURN_MARKER}[A-Z]{0,3}$`);

/** Whether `text` is only the marker, once or repeated, allowing whitespace and code formatting around it. */
export function isQuietTurnMarker(text: string): boolean {
  const parts = text.split(/\s+/).map((part) => part.replace(/^`+|`+$/g, '')).filter(Boolean);
  return parts.length > 0 && parts.every((part) => QUIET_TURN_PART.test(part));
}
