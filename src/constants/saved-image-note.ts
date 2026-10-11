/**
 * The note a coordinator gets with an attached image, naming where the image
 * was saved so it can hand the path to a worker (coordinator-attachments.ts).
 * It travels as its own text block beside the image, and the thread
 * recognises it here so the user's bubble shows the image and what they
 * typed, not the note meant for the agent.
 */

const SINGLE = /^Attached image saved at (.+) — give a worker this path if it needs the image\.$/;
const MANY = /^Attached images saved at:\n((?:- .+\n)+)Give a worker these paths if it needs the images\.$/;

export function formatSavedImageNote(paths: readonly string[]): string {
  return paths.length === 1
    ? `Attached image saved at ${paths[0]} — give a worker this path if it needs the image.`
    : `Attached images saved at:\n${paths.map((file) => `- ${file}`).join('\n')}\nGive a worker these paths if it needs the images.`;
}

/** The saved paths a note names, or null when the text is not one. */
export function parseSavedImageNote(text: string): string[] | null {
  const single = SINGLE.exec(text);
  if (single) return [single[1]];
  const many = MANY.exec(text);
  return many ? many[1].trimEnd().split('\n').map((line) => line.slice(2)) : null;
}

/** True for a content block that is the saved-image note rather than typed text. */
export function isSavedImageNoteBlock(block: { type: string; text?: string }): boolean {
  return block.type === 'text' && typeof block.text === 'string' && parseSavedImageNote(block.text) !== null;
}
