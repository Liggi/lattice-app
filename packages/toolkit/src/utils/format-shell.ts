/**
 * Lightweight shell command formatter for display purposes.
 * Breaks long pipe chains, && / || sequences across lines for readability.
 * Not a full parser — uses heuristic splitting that respects quoting.
 */

const LINE_THRESHOLD = 80;

/** Track quoting state to avoid splitting inside strings. */
function findSplitPoints(cmd: string): number[] {
  const points: number[] = [];
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let parenDepth = 0;
  let braceDepth = 0;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const prev = i > 0 ? cmd[i - 1] : '';

    // Handle escapes
    if (prev === '\\') continue;

    // Track quoting
    if (ch === "'" && !inDouble && !inBacktick) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle && !inBacktick) { inDouble = !inDouble; continue; }
    if (ch === '`' && !inSingle) { inBacktick = !inBacktick; continue; }

    // Don't split inside any quoting or subshell
    if (inSingle || inDouble || inBacktick) continue;

    // Track nesting
    if (ch === '(' || (ch === '$' && cmd[i + 1] === '(')) { parenDepth++; continue; }
    if (ch === ')' && parenDepth > 0) { parenDepth--; continue; }
    if (ch === '{') { braceDepth++; continue; }
    if (ch === '}' && braceDepth > 0) { braceDepth--; continue; }
    if (parenDepth > 0 || braceDepth > 0) continue;

    // Detect operators: |, &&, ||, ;
    if (ch === '|' && cmd[i + 1] !== '|') {
      // Pipe — split BEFORE the pipe
      points.push(i);
    } else if (ch === '&' && cmd[i + 1] === '&') {
      points.push(i);
    } else if (ch === '|' && cmd[i + 1] === '|') {
      points.push(i);
    } else if (ch === ';') {
      points.push(i + 1); // split AFTER semicolon
    }
  }

  return points;
}

/** Format a shell command by breaking at operators when the line is long. */
export function formatShellCommand(cmd: string): string {
  // Don't touch short commands or heredocs
  const trimmed = cmd.trim();
  if (trimmed.length <= LINE_THRESHOLD) return trimmed;
  if (/<<[-']?\s*\w/.test(trimmed)) return trimmed; // heredoc

  const points = findSplitPoints(trimmed);
  if (points.length === 0) return trimmed;

  // Build segments
  const segments: string[] = [];
  let last = 0;
  for (const pt of points) {
    const seg = trimmed.slice(last, pt).trim();
    if (seg) segments.push(seg);
    last = pt;
  }
  const tail = trimmed.slice(last).trim();
  if (tail) segments.push(tail);

  if (segments.length <= 1) return trimmed;

  // Join with newlines — first segment has no indent, rest indented
  return segments
    .map((seg, i) => i === 0 ? seg : `  ${seg}`)
    .join('\n');
}
