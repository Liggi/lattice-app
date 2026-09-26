/**
 * The hosted Slack connector returns messages as formatted text rather than CSV, in
 * five layouts: a thread, a channel in detailed or concise form, and search results in
 * detailed or concise form. This turns each into the same message records the CSV path
 * produces, so both servers render as Slack messages.
 */

export interface SlackTextMessage {
  name: string;
  /** "Sep 25 17:08", already formatted — the source gives a zone name, not an offset. */
  time: string;
  text: string;
  channel?: string;
  permalink?: string;
  reactions?: string;
  files?: string;
  bot?: boolean;
  isReply?: boolean;
}

export interface ParsedSlackText {
  /** The channel the whole result came from, when the text names one. */
  channel?: string;
  messages: SlackTextMessage[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STAMP = String.raw`\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?: [A-Z]{2,5})?`;

/** "2026-09-25 17:08:20 BST" → "Sep 25 17:08". */
export function slackTime(stamp: string): string {
  const m = stamp.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
  if (!m) return stamp.trim();
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])} ${m[4]}:${m[5]}`;
}

/** "Ada Lovelace <ada@example.com> (ID: U123)  [BOT]" → name and bot flag. */
function sender(raw: string): { name: string; bot: boolean } {
  const bot = /\[BOT\]/.test(raw);
  const name = raw.replace(/\[BOT\]/, '').replace(/\s*<[^>]*>/, '').replace(/\s*\((?:ID: )?[UBW][A-Z0-9]+\)/, '').trim();
  return { name: name || 'unknown', bot };
}

/** "DM (D123)" → "DM"; "#general (ID: C123)" → "#general"; a bare ID says nothing. */
function channelName(raw: string): string | undefined {
  const name = raw.replace(/\s*\((?:ID: )?[A-Z0-9]+\)\s*$/, '').trim();
  if (!name || /^[CDG][A-Z0-9]{6,}$/.test(name)) return undefined;
  return name;
}

/** Trailing "Reactions:" and "Files:" lines are metadata, not part of what was said. */
function splitBody(body: string): { text: string; reactions?: string; files?: string } {
  const lines = body.replace(/\s+$/, '').split('\n');
  let reactions: string | undefined;
  let files: string | undefined;
  while (lines.length) {
    const last = lines[lines.length - 1];
    const r = last.match(/^Reactions: (.+)$/);
    const f = last.match(/^Files: (.+)$/);
    if (r) reactions = r[1].trim();
    else if (f) files = f[1].replace(/ID: [^,)]*,\s*/g, '').trim();
    else if (!last.trim()) { /* blank separator */ } else break;
    lines.pop();
  }
  return { text: lines.join('\n').replace(/^\n+/, ''), reactions, files };
}

function field(block: string, name: string): string | undefined {
  return block.match(new RegExp(`^${name}: ?(.*)$`, 'm'))?.[1]?.trim();
}

function parseThread(text: string): ParsedSlackText {
  const blocks = text.split(/^(?:=== THREAD PARENT MESSAGE ===|--- Reply \d+ of \d+ ---)\s*$/m).slice(1);
  const messages = blocks.map((block, i) => {
    const cleaned = block
      .replace(/^=== THREAD REPLIES \(\d+ total\) ===\s*$/m, '')
      .replace(/^No thread messs?ages\s*$/m, '');
    const from = sender(field(cleaned, 'From') ?? '');
    const bodyStart = cleaned.search(/^Message TS: .*$/m);
    const body = bodyStart >= 0 ? cleaned.slice(bodyStart).replace(/^Message TS: .*\n?/, '') : '';
    return { ...from, time: slackTime(field(cleaned, 'Time') ?? ''), ...splitBody(body), isReply: i > 0 };
  });
  return { messages };
}

/** "THREAD: parent [Name <email>]" then one "> Name <email>: text" per reply, no times. */
function parseConciseThread(text: string): ParsedSlackText {
  const parent = text.match(/^THREAD: ([\s\S]*?) \[([^\]\n]+)\]\s*$/m);
  const messages: SlackTextMessage[] = [];
  if (parent) messages.push({ ...sender(parent[2]), time: '', ...splitBody(parent[1]) });
  const heads = [...text.matchAll(/^> ([^\n:<]+?)(?: <[^>\n]*>)?: /gm)];
  heads.forEach((h, i) => {
    const start = (h.index ?? 0) + h[0].length;
    const end = heads[i + 1]?.index ?? text.length;
    messages.push({ ...sender(h[1]), time: '', ...splitBody(text.slice(start, end)), isReply: true });
  });
  return { messages };
}

function parseDetailedChannel(text: string, channel?: string): ParsedSlackText {
  const re = /^=== Message from (.+?) at (.+?) ===\s*$/gm;
  const heads = [...text.matchAll(re)];
  const messages = heads.map((h, i) => {
    const start = (h.index ?? 0) + h[0].length;
    const end = heads[i + 1]?.index ?? text.length;
    const body = text.slice(start, end).replace(/^\s*Message TS: .*\n?/, '');
    return { ...sender(h[1]), time: slackTime(h[2]), ...splitBody(body) };
  });
  return { channel, messages };
}

function parseConciseChannel(text: string, channel?: string): ParsedSlackText {
  const re = new RegExp(String.raw`^([^\n:<]+?)(?: <[^>\n]*>)?: ([\s\S]*?) \[(${STAMP})\]\s*$`, 'gm');
  const body = text.replace(/^Channel: .*$/m, '');
  const messages = [...body.matchAll(re)].map((m) => ({ ...sender(m[1]), time: slackTime(m[3]), ...splitBody(m[2]) }));
  return { channel, messages };
}

function parseDetailedSearch(text: string): ParsedSlackText {
  const blocks = text.split(/^### Result \d+ of \d+\s*$/m).slice(1);
  const messages = blocks.map((block) => {
    const permalink = field(block, 'Permalink')?.match(/\((https?:[^)]+)\)/)?.[1];
    const textAt = block.search(/^Text: ?/m);
    const body = textAt >= 0 ? block.slice(textAt).replace(/^Text: ?\n?/, '').replace(/\n---\s*$/, '') : '';
    return {
      ...sender(field(block, 'From') ?? ''),
      time: slackTime(field(block, 'Time') ?? ''),
      channel: channelName(field(block, 'Channel') ?? ''),
      permalink,
      ...splitBody(body),
    };
  });
  return { messages };
}

function parseConciseSearch(text: string): ParsedSlackText {
  const heads = [...text.matchAll(/^\d+\. (.+?) - ([^:\n]+): /gm)];
  const messages = heads.map((h, i) => {
    const start = (h.index ?? 0) + h[0].length;
    const end = heads[i + 1]?.index ?? text.length;
    let body = text.slice(start, end).replace(/\s+$/, '');
    const stamp = body.match(new RegExp(String.raw`\s(${STAMP})$`));
    if (stamp) body = body.slice(0, stamp.index);
    return { ...sender(h[2]), time: stamp ? slackTime(stamp[1]) : '', channel: channelName(h[1]), ...splitBody(body) };
  });
  return { messages };
}

/** Messages from a hosted Slack connector's text, or null when the text is not messages. */
export function parseSlackText(text: string): ParsedSlackText | null {
  const t = text.replace(/\r/g, '');
  const channel = channelName(t.match(/^Channel: (.+)$/m)?.[1] ?? '');
  let parsed: ParsedSlackText | null = null;

  if (/^=== THREAD PARENT MESSAGE ===/m.test(t)) parsed = parseThread(t);
  else if (/^THREAD: /.test(t)) parsed = parseConciseThread(t);
  else if (/^=== Message from /m.test(t)) parsed = parseDetailedChannel(t, channel);
  else if (/^### Result \d+ of \d+/m.test(t)) parsed = parseDetailedSearch(t);
  else if (/^## Messages \(\d+ results?\)/m.test(t)) parsed = parseConciseSearch(t);
  else if (/^Channel: /m.test(t)) parsed = parseConciseChannel(t, channel);

  return parsed && parsed.messages.length ? parsed : null;
}
