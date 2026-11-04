/**
 * `lattice ask` — an agent puts a decision to the user as a card in its own
 * thread. The agent ends its turn as usual; the user's tap arrives later as
 * one line attributed to them.
 */

import { serverAuthHeaders } from './server-auth.js';
import { readServerAddress } from './session-commands.js';
import { DECISION_MAX_OPTIONS, DECISION_MIN_OPTIONS, type DecisionOptionData } from '../types/decisions.js';

export const ASK_USAGE = `  lattice ask "<question>" --session <conv-id> [--thread <id>]
        --option "<label>" --because "<what choosing it sets in motion>" [--recommended]
        --option … (${DECISION_MIN_OPTIONS} to ${DECISION_MAX_OPTIONS} options)
      Put a decision that is the user's to make in front of them as a card
      they answer with a tap, or in their own words. Use it rarely: only when
      you cannot go on without their call. The card replaces the closing
      question in your message; do not ask it in prose as well. Post it,
      write that message, then end your turn: the card shows below the
      message once the turn ends, not before. The answer arrives as a
      message from the user.
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

export async function runAskCommand(args: string[]): Promise<void> {
  let session: string | undefined;
  let thread: number | undefined;
  let withdraw = false;
  let reason: string | undefined;
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
  const question = words.join(' ');
  if (!question.trim()) fail(`no question.\n\nUsage:\n${ASK_USAGE}`);
  if (!session) fail('--session is required: the card goes in that conversation\'s thread.');

  const body = await post(`${encodeURIComponent(session)}/decisions`, { question, options, ...(thread !== undefined ? { thread } : {}) }) as { replaced?: string | null };
  process.stdout.write(
    'The question is on a card in your thread. Now write your message and end your turn: the card shows below the message once your turn ends.'
    + ' The message does not ask the question again or mention the card. The answer arrives as a message from the user.'
    + (body.replaced ? ' It replaced your earlier question, which had no answer yet.' : '')
    + '\n',
  );
}

async function post(path: string, payload: unknown): Promise<unknown> {
  const { host, port } = readServerAddress();
  let response: Response;
  try {
    response = await fetch(`http://${host}:${port}/api/harness/${path}`, {
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
