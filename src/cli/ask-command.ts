/**
 * `lattice ask` — an agent puts a decision to the user as a card in its own
 * thread (and in the cross-project Inbox). The agent ends its turn as usual;
 * the user's tap arrives later as one line attributed to them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { serverAuthHeaders } from './server-auth.js';
import { readServerAddress } from './session-commands.js';
import { DECISION_MAX_OPTIONS, DECISION_MIN_OPTIONS, type DecisionOptionData } from '../types/decisions.js';
import {
  INBOX_REQUEST_KINDS,
  type InboxArtifact,
  type InboxMetric,
  type InboxRequestKind,
} from '../types/inbox-feed.js';

export const ASK_USAGE = `  lattice ask "<question>" --session <conv-id> [--thread <id>]
        --kind <go-ahead|decision|review|access|info>
        --context "<cold-read orientation fact>" [--context ...]
        [--priority-reason "<what is blocked>"]
        [--metric "<label>=<value>[:better|:worse]" ...]
        [--draft "<text>" | --draft-file <path>] [--draft-label "<label>"] [--draft-meta "<recipient>"] [--editable]
        [--image "<abs-path-or-url>[::<caption>]" ...]
        [--if-unanswered "<what happens and when>"]
        --option "<label>" --because "<what choosing it sets in motion>" [--recommended]
        --option … (${DECISION_MIN_OPTIONS} to ${DECISION_MAX_OPTIONS} options)
      Put a decision that is the user's to make in front of them as a card
      they answer with a tap, or in their own words. Use it rarely: only when
      you cannot go on without their call (do reversible prep like drafting a
      message or low-stakes internal plumbing first without asking).
      Cards are read cold in Inbox without opening chat, so Lattice enforces:
      - --kind and 1-3 plain-English --context bullets (no raw hashes, conv IDs,
        file paths, or "see chat" pointers);
      - --draft/--draft-file inline whenever asking to send/approve a message;
      - --image inline for visual/UI choices (one captioned --image per option
        when comparing layouts or mockups);
      - one decision per card (split unrelated calls into separate asks).
      The card replaces the closing question in your message; do not ask it in
      prose as well. Post it, write that message, then end your turn: the card
      shows below the message once the turn ends, not before. The answer
      arrives as a message from the user.
      --because and --recommended belong to the --option before them. Asking
      again replaces a question still unanswered in the thread. Workers ask
      their coordinator instead. A coordinator names the project thread the
      question is about with --thread, so the card closes if the user
      dismisses that thread from their panel.

  lattice ask --withdraw --session <conv-id> [--thread <id>] [--reason "<how it was settled>"]
      Take down your open question card. When a question you asked is
      settled some other way (the user answered in chat or elsewhere, or the
      work made it moot), withdraw the card in the same turn. The card closes
      as withdrawn, with the reason under it; you are told nothing more, and
      the project thread it was about stays open. --thread refuses if the
      open card is about a different thread.
`;

function fail(message: string): never {
  process.stderr.write(`lattice ask: ${message}\n`);
  process.exit(1);
}

function parseMetricFlag(raw: string): InboxMetric {
  const eq = raw.indexOf('=');
  if (eq <= 0) fail('--metric takes "<label>=<value>" (optionally ending in :better, :worse, or :neutral).');
  const label = raw.slice(0, eq).trim();
  let value = raw.slice(eq + 1).trim();
  let tone: InboxMetric['tone'];
  for (const suffix of ['better', 'worse', 'neutral'] as const) {
    if (value.endsWith(`:${suffix}`)) {
      tone = suffix;
      value = value.slice(0, -(suffix.length + 1)).trim();
      break;
    }
  }
  if (!label || !value) fail('--metric needs both a label and a value.');
  return { label, value, ...(tone ? { tone } : {}) };
}

function parseImageFlag(raw: string): { src: string; caption?: string } {
  const sep = raw.indexOf('::');
  const target = (sep >= 0 ? raw.slice(0, sep) : raw).trim();
  const caption = sep >= 0 ? raw.slice(sep + 2).trim() : undefined;
  if (!target) fail('--image needs a file path or URL.');
  const src = /^https?:\/\//i.test(target) || target.startsWith('/api/')
    ? target
    : `/api/images?path=${encodeURIComponent(path.resolve(target))}`;
  return { src, ...(caption ? { caption } : {}) };
}

export async function runAskCommand(args: string[]): Promise<void> {
  let session: string | undefined;
  let thread: number | undefined;
  let withdraw = false;
  let reason: string | undefined;
  let requestKind: InboxRequestKind | undefined;
  let priorityReason: string | undefined;
  let ifUnanswered: string | undefined;
  const context: string[] = [];
  const metrics: InboxMetric[] = [];
  let draftBody: string | undefined;
  let draftLabel: string | undefined;
  let draftMeta: string | undefined;
  let draftEditable = false;
  const images: Array<{ src: string; caption?: string }> = [];
  const words: string[] = [];
  const options: DecisionOptionData[] = [];
  const last = (flag: string): DecisionOptionData => options.at(-1) ?? fail(`${flag} comes after the --option it belongs to.`);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(`Usage:\n${ASK_USAGE}`);
      return;
    }
    if (arg === '--recommended') {
      last(arg).recommended = true;
      continue;
    }
    if (arg === '--editable') {
      draftEditable = true;
      continue;
    }
    if (arg === '--withdraw') {
      withdraw = true;
      continue;
    }
    if (arg === '--reason') {
      reason = args[++i];
      if (reason === undefined) fail('--reason needs a value.');
      continue;
    }
    if (arg === '--thread') {
      const value = Number(String(args[++i] ?? '').replace(/^\[|\]$/g, ''));
      if (!Number.isInteger(value)) fail('--thread takes the thread id `session state` prints in brackets.');
      thread = value;
      continue;
    }
    if (arg === '--kind') {
      const value = args[++i];
      if (!value || !(INBOX_REQUEST_KINDS as readonly string[]).includes(value)) {
        fail(`--kind must be one of ${INBOX_REQUEST_KINDS.join(', ')}.`);
      }
      requestKind = value as InboxRequestKind;
      continue;
    }
    if (arg === '--priority-reason') {
      priorityReason = args[++i];
      if (priorityReason === undefined) fail('--priority-reason needs a value.');
      continue;
    }
    if (arg === '--if-unanswered') {
      ifUnanswered = args[++i];
      if (ifUnanswered === undefined) fail('--if-unanswered needs a value.');
      continue;
    }
    if (arg === '--context') {
      const value = args[++i];
      if (value === undefined) fail('--context needs a value.');
      context.push(value);
      continue;
    }
    if (arg === '--metric') {
      const value = args[++i];
      if (value === undefined) fail('--metric needs a value.');
      metrics.push(parseMetricFlag(value));
      continue;
    }
    if (arg === '--draft') {
      const value = args[++i];
      if (value === undefined) fail('--draft needs a value.');
      draftBody = value;
      continue;
    }
    if (arg === '--draft-file') {
      const filePath = args[++i];
      if (!filePath) fail('--draft-file needs a path.');
      try {
        draftBody = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        fail(`could not read --draft-file "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }
    if (arg === '--draft-label') {
      draftLabel = args[++i];
      if (draftLabel === undefined) fail('--draft-label needs a value.');
      continue;
    }
    if (arg === '--draft-meta') {
      draftMeta = args[++i];
      if (draftMeta === undefined) fail('--draft-meta needs a value.');
      continue;
    }
    if (arg === '--image') {
      const value = args[++i];
      if (value === undefined) fail('--image needs a file path or URL.');
      images.push(parseImageFlag(value));
      continue;
    }
    if (arg === '--session' || arg === '--option' || arg === '--because') {
      const value = args[++i];
      if (value === undefined) fail(`${arg} needs a value.`);
      if (arg === '--session') session = value;
      else if (arg === '--option') options.push({ label: value, consequence: '' });
      else last(arg).consequence = value;
      continue;
    }
    if (arg.startsWith('--')) fail(`unknown flag ${arg}.\n\nUsage:\n${ASK_USAGE}`);
    words.push(arg);
  }
  if (withdraw) {
    if (words.length > 0 || options.length > 0) fail('--withdraw takes down your open card; it takes no question or options.');
    if (!session) fail('--session is required: the card is in that conversation\'s thread.');
    const body = await post(`${encodeURIComponent(session)}/decisions/withdraw`, { ...(thread !== undefined ? { thread } : {}), ...(reason ? { reason } : {}) }) as { question?: string };
    process.stdout.write(`Withdrew your question "${body.question}". Its card is closed and nothing more comes of it.\n`);
    return;
  }
  if (reason !== undefined) fail('--reason goes with --withdraw.');
  if (draftBody !== undefined && images.length > 0) fail('pass either --draft/--draft-file or --image, not both.');
  const question = words.join(' ');
  if (!question.trim()) fail(`no question.\n\nUsage:\n${ASK_USAGE}`);
  if (!session) fail('--session is required: the card goes in that conversation\'s thread.');

  let artifact: InboxArtifact | undefined;
  if (draftBody !== undefined) {
    artifact = {
      kind: 'message',
      label: draftLabel?.trim() || 'Draft',
      ...(draftMeta?.trim() ? { meta: draftMeta.trim() } : {}),
      body: draftBody,
      ...(draftEditable ? { editable: true } : {}),
    };
  } else if (images.length > 0) {
    artifact = {
      kind: 'image',
      label: draftLabel?.trim() || (images.length > 1 ? 'Screenshots' : 'Screenshot'),
      ...(draftMeta?.trim() ? { meta: draftMeta.trim() } : {}),
      images,
    };
  }

  const body = await post(`${encodeURIComponent(session)}/decisions`, {
    question,
    options,
    ...(thread !== undefined ? { thread } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(priorityReason ? { priorityReason } : {}),
    ...(context.length > 0 ? { context } : {}),
    ...(metrics.length > 0 ? { metrics } : {}),
    ...(artifact ? { artifact } : {}),
    ...(ifUnanswered ? { ifUnanswered } : {}),
  }) as { replaced?: string | null };
  process.stdout.write(
    'The question is on a card in your thread. Now write your message and end your turn: the card shows below the message once your turn ends.'
    + ' The message does not ask the question again or mention the card. The answer arrives as a message from the user.'
    + (body.replaced ? ' It replaced your earlier question, which had no answer yet.' : '')
    + '\n',
  );
}

async function post(pathSuffix: string, payload: unknown): Promise<unknown> {
  const { host, port } = readServerAddress();
  let response: Response;
  try {
    response = await fetch(`http://${host}:${port}/api/harness/${pathSuffix}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...serverAuthHeaders() },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    fail(`could not reach the Lattice server at ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) fail(body.error ?? `the server answered ${response.status}.`);
  return body;
}
