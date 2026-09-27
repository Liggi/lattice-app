/**
 * Which parts of a delivered input the user actually wrote.
 *
 * `input:sent` records everything a session was handed: the user's messages,
 * but also project-record nudges, compaction restores, worker reports, other
 * agents' messages, reactions and the pickup brief a coordinator writes for a
 * worker. Session insights are meant to describe what the user asked for, and
 * on 2026-09-26 98% of the text they were sent was this server-written
 * material — about 44k tokens a call, ~$80/day on Sonnet 5.
 *
 * The shapes recognised here are the ones Lattice itself writes
 * (`worker-events.ts`, `session-inbox.ts`, `message-reactions.ts`,
 * `worker-report-delivery.ts`). Everything else counts as the user's.
 */

import { stripContextRestore, stripPreamble } from '../../types/worker-events.js';

/**
 * A part of an input starts at one of these headers, at the start of a line after a
 * blank one. `Automatic quick answer` is kept for history written before 2026-09-26.
 */
const ITEM_HEADER = /\n\n(?=\[(?:From |Report from worker |Question from worker |Automatic quick answer|Orientation review))/;

/** The user's own words in one delivered input, or null when none of it is theirs. */
export function humanTextOfInput(text: string, userName: string): string | null {
  let rest = stripContextRestore(text.trim()).trim();
  // A worker's first input is the brief its coordinator wrote, not the user.
  if (rest.startsWith('Picked up from ')) return null;
  // A coordinator's first input is the server preamble followed by the user's opening message.
  rest = stripPreamble(rest).trim();

  const userHeader = `[From ${userName} · `;
  const name = userName.toLowerCase();
  const parts: string[] = [];
  for (const item of rest.split(ITEM_HEADER)) {
    const part = item.trim();
    if (!part) continue;
    if (part.toLowerCase().startsWith(userHeader.toLowerCase())) {
      const body = part.slice(part.indexOf('\n') + 1).trim();
      if (part.includes('\n') && body) parts.push(body);
      continue;
    }
    if (part.startsWith('[')) {
      // Other senders' headers, and the user's annotation block, which is theirs.
      if (part.startsWith('[Notes on your earlier output]')) parts.push(part);
      continue;
    }
    const lower = part.toLowerCase();
    if (lower.startsWith(`${name} reacted `) || lower.startsWith(`${name} removed the `)) continue;
    if (lower.startsWith(`${name} stopped your worker `)) continue;
    if (/^\/\S+$/.test(part)) continue; // a bare slash command such as /compact
    parts.push(part);
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * The task a coordinator wrote for a worker, from the worker's first input:
 * the text after the pickup preamble. Not the user's words, but the one
 * statement of what the session is for when the user never writes to it.
 */
export function pickupBriefOf(text: string): string | null {
  const rest = stripContextRestore(text.trim()).trim();
  if (!rest.startsWith('Picked up from ')) return null;
  const brief = stripPreamble(rest).trim();
  return brief && brief !== rest ? brief : null;
}

export const INSIGHTS_MESSAGE_CAP = 1500;

/**
 * The start of a long message, with the cut stated in the text so the model
 * knows it is reading an opening and how much it is not seeing. The cut falls
 * on a word boundary.
 */
export function capMessage(text: string, cap = INSIGHTS_MESSAGE_CAP): string {
  if (text.length <= cap) return text;
  const head = text.slice(0, cap);
  const lastSpace = head.search(/\s\S*$/);
  const kept = (lastSpace > cap * 0.8 ? head.slice(0, lastSpace) : head).trimEnd();
  return `${kept} … [message continues; ${text.length - kept.length} more characters not shown]`;
}

/** A number with an optional range end and unit, not an id: "$580-$840", "~20k", "1.1-1.9s", "2-week". */
const MEASURE = /^[$~#]?(\d+(?:\.\d+)?)(?:-[$]?(\d+(?:\.\d+)?))?(?:%|x|k|m|h|s|ms|gb|mb|kb|min|mins|hrs?|minutes?|hours?|days?|weeks?|months?|-[a-z]+(?:-[a-z]+)*)?$/i;

/** One way of writing numbers on both sides: "4,343" as "4343", and en/em dashes as hyphens. */
function sameNumberFormat(text: string): string {
  return text.replace(/(?<=\d)[,_](?=\d{3}\b)/g, '').replace(/[\u2013\u2014\u2212]/g, '-').replace(/\u2192/g, ' ');
}

/**
 * Names, numbers, versions and ids in a mission that do not appear in the text
 * it was written from. A title that names the wrong model version, ticket or
 * product reads as right and is not; one that names nothing specific is only
 * vague. So a detail the input does not contain is grounds to reject the title.
 *
 * A detail is a word with a digit ("5.5", "SLING-10851"), inner capitals
 * ("BigQuery"), or a capital letter after the first word (a proper noun).
 * Short all-caps acronyms ("UI", "PII") describe rather than name, and are let
 * through. Matching ignores case and allows "GPT-Live" to match "gpt live".
 */
export function unsupportedDetails(mission: string, input: string): string[] {
  const words = sameNumberFormat(mission).split(/[\s,;:()"'`/]+/).map((w) => w.replace(/^[^\w$~#]+|[^\w%]+$/g, '').replace(/'s$/i, '')).filter(Boolean);
  const haystack = sameNumberFormat(input).toLowerCase();
  const numbers = new Set(haystack.match(/\d+(?:\.\d+)?/g) ?? []);
  const tokens = new Set(haystack.split(/[\s,;:()"'`/[\]{}<>!?*]+/).map((t) => t.replace(/^[^\w]+|[^\w]+$/g, '').replace(/'s$/, '')));
  const loose = haystack.replace(/[-_\s.]+/g, '');
  const isSupported = (word: string, index: number): boolean => {
    if (/^[A-Z&]{2,4}s?$/.test(word)) return true;
    // "Alex-specific", "Jev-scored": a compound is fine when its named part is.
    if (/^[A-Za-z]+(-[A-Za-z]+)+$/.test(word)) return word.split('-').every((part, i) => isSupported(part, index + i));
    const detail = /\d/.test(word) || /[a-z][A-Z]/.test(word) || (index > 0 && /^[A-Z]/.test(word));
    if (!detail) return true;
    // A count, range or measure ("4343", "25-74%", "14x", "10-minute") only has
    // to use numbers the input has. Ids and versions are matched whole below:
    // "6ff8817" is not "6ff6f817", and "5" is not "5.5".
    const measure = MEASURE.exec(word);
    if (measure) return [measure[1], measure[2]].filter(Boolean).every((n) => numbers.has(n));
    const lower = word.toLowerCase();
    if (tokens.has(lower) || tokens.has(`${lower}s`)) return true;
    // "Opus5" for "Opus 5": run together, but long enough not to match by accident.
    if (lower.length >= 4 && /\d/.test(lower) && loose.includes(lower)) return true;
    // A hyphenated or dotted detail may be spelled with spaces, or sit inside a longer token.
    if (/[-_.]/.test(lower) && (haystack.includes(lower) || loose.includes(lower.replace(/[-_.]+/g, '')))) return true;
    // "GPT" out of "GPT-Live": a part of a compound the input does contain.
    return !/\d/.test(lower) && [...tokens].some((t) => t.split(/[-_.]/).includes(lower));
  };
  return words.filter((word, index) => !isSupported(word, index));
}

/** Folders people keep many repositories in; a session started there has not said which one it is about. */
const CONTAINER_FOLDERS = new Set(['src', 'code', 'dev', 'developer', 'projects', 'repos', 'git', 'github', 'workspace', 'work', 'documents', 'desktop', 'tmp']);

/**
 * Whether a working directory says nothing about the project: the home folder
 * or anything above it, the launch folder every session starts in, or a
 * container folder like `~/src`. The model otherwise names the project after
 * the folder, and every session launched from `~/src` became project "src".
 */
export function isGenericFolder(dir: string | undefined, home: string, launchFolder: string | undefined): boolean {
  if (!dir) return true;
  const expand = (p: string) => p.replace(/^~(?=\/|$)/, home).replace(/\/+$/, '') || '/';
  const path = expand(dir.trim());
  const homePath = expand(home);
  if (path === '/' || homePath === path || homePath.startsWith(`${path}/`)) return true;
  if (/^\/(home|Users)\/[^/]+$/.test(path) || path === '/root') return true;
  if (launchFolder?.trim() && expand(launchFolder.trim()) === path) return true;
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return CONTAINER_FOLDERS.has(base);
}
