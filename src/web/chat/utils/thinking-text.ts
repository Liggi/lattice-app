/**
 * Codex and Astra write a thinking summary as a list of bold headers on
 * consecutive lines ("**Reading saved thread state**\n**Setting Astra to
 * medium**"). Markdown treats a single newline as a space, so those arrive in
 * the thread as one run-on bold sentence — 398 of 1426 stored thinking blocks
 * on 2026-09-20 had breaks that rendered this way. Claude's summaries separate
 * paragraphs with a blank line and are unaffected.
 *
 * So end each line that is followed by another line with the two spaces
 * markdown reads as a hard break, leaving fenced code alone.
 */
export function preserveThinkingBreaks(text: string): string {
  const lines = text.split('\n');
  let inFence = false;
  return lines
    .map((line, i) => {
      if (/^\s{0,3}(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const next = lines[i + 1];
      if (next === undefined || !line.trim() || !next.trim()) return line;
      return `${line.replace(/\s+$/, '')}  `;
    })
    .join('\n');
}
