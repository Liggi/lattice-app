/**
 * What a coordinator writes to end a turn that has nothing for the user.
 * Models told to end with no text often write a line about the silence
 * instead ("(no text)"), so the preamble gives them this to write and the
 * thread drops it like blank text.
 */
export const QUIET_TURN_MARKER = 'NO_REPLY';

/** Whether `text` is only the marker, allowing whitespace and code formatting around it. */
export function isQuietTurnMarker(text: string): boolean {
  return text.trim().replace(/^`+|`+$/g, '').trim() === QUIET_TURN_MARKER;
}
