/**
 * `lattice explain` — an agent asks the user to explain something in their
 * own words, as a card in its own thread that checks their draft as they
 * type. The agent ends its turn as usual; the result arrives later as one
 * line. `lattice explain log` replays how the user got there.
 */

import { readFileSync } from 'node:fs';
import { serverAuthHeaders } from './server-auth.js';
import { readServerAddress } from './session-commands.js';
import { EXPLAIN_MAX_IDEAS, EXPLAIN_MAX_MISCONCEPTIONS } from '../types/explain.js';
import { parseJson } from '../utils/json.js';

export const EXPLAIN_USAGE = `  lattice explain --session <conv-id> --rubric - <<'EOF' … EOF
      Check the user's understanding: they explain something in their own
      words on a card that marks, as they type, which ideas their explanation
      has, without showing the ideas. Use it when the user wants to learn or
      check what they know, not to quiz them unasked. The rubric is JSON on
      stdin, written in the same command as a heredoc: the chat hides that
      command from the user, but would show the ideas in a file you wrote in
      a separate step, or in your message. (\`--rubric <absolute path>\` also
      works.)
        { "prompt": "Explain why the Earth has seasons.",
          "ideas": [ { "id": "tilt", "label": "The cause",
                       "statement": "<the one fact the explanation must state>",
                       "hint": "<a question that points at it without saying it>" } ],
          "misconceptions": [ { "idea": "tilt",
                       "statement": "<a wrong belief that undoes that idea>",
                       "nudge": "<a question that makes them look again>" } ] }
      1 to ${EXPLAIN_MAX_IDEAS} ideas, up to ${EXPLAIN_MAX_MISCONCEPTIONS} misconceptions. Each idea is ONE fact: two facts in one
      idea leave the user stuck with it half-marked and no way to see which
      half is missing. Each hint points without giving the answer away: not a
      statement of the idea (that is refused), and not a yes/no question
      whose answer is the idea. Write the ideas from the source the user is
      learning from, not from memory. Post it, write your message, then end
      your turn. The result arrives as a message from the user.

  lattice explain log --session <conv-id> [--id <explain-id>]
      How the user's attempt went: each change in the marks with their draft
      at that moment, the hints they opened, and where they stalled. The
      latest explain-back in the thread unless --id names one.
`;

function fail(message: string): never {
  process.stderr.write(`lattice explain: ${message}\n`);
  process.exit(1);
}

function parse(args: string[], allowed: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!allowed.includes(arg)) fail(`unknown argument ${arg}.\n\nUsage:\n${EXPLAIN_USAGE}`);
    const value = args[++i];
    if (value === undefined) fail(`${arg} needs a value.`);
    flags[arg] = value;
  }
  return flags;
}

async function call(path: string, init: RequestInit): Promise<Response> {
  const { host, port } = readServerAddress();
  try {
    return await fetch(`http://${host}:${port}/api/harness/${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...serverAuthHeaders(), ...(init.headers ?? {}) },
    });
  } catch (error) {
    fail(`could not reach the Lattice server at ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function errorOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `the server answered ${response.status}.`;
}

export async function runExplainCommand(args: string[]): Promise<void> {
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(`Usage:\n${EXPLAIN_USAGE}`);
    return;
  }

  if (args[0] === 'log') {
    const flags = parse(args.slice(1), ['--session', '--id']);
    const session = flags['--session'] ?? fail('--session is required: the thread the explain-back is in.');
    const query = flags['--id'] ? `?id=${encodeURIComponent(flags['--id'])}` : '';
    const response = await call(`${encodeURIComponent(session)}/explain/log${query}`, { method: 'GET' });
    if (!response.ok) fail(await errorOf(response));
    process.stdout.write(`${await response.text()}\n`);
    return;
  }

  const flags = parse(args, ['--session', '--rubric']);
  const session = flags['--session'] ?? fail('--session is required: the card goes in that conversation\'s thread.');
  const source = flags['--rubric'] ?? fail(`--rubric is required.\n\nUsage:\n${EXPLAIN_USAGE}`);
  let rubric: unknown;
  try {
    rubric = parseJson(readFileSync(source === '-' ? 0 : source, 'utf8'));
  } catch (error) {
    fail(`the rubric is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const response = await call(`${encodeURIComponent(session)}/explain`, { method: 'POST', body: JSON.stringify(rubric) });
  if (!response.ok) fail(await errorOf(response));
  const body = (await response.json()) as { id: string };
  process.stdout.write(
    `The explain-back is on a card in your thread (${body.id}). Now write your message and end your turn: the card shows below the message once your turn ends.`
    + ' The message does not repeat the prompt or hint at the ideas. The result arrives as a message from the user.\n',
  );
}
