/**
 * `lattice feedback "<message>"` — an agent proposes feedback about Lattice.
 *
 * It only ever saves a draft. The user reads the exact text in Lattice and
 * decides whether to send it; there is deliberately no flag that sends.
 */

import { serverAuthHeaders } from './server-auth.js';
import { readServerAddress } from './session-commands.js';

export const FEEDBACK_USAGE = `  lattice feedback "<message>" [--session <conv-id>] [--category bug|suggestion|other]
      Propose feedback about Lattice itself to its maintainer: a concrete
      problem you hit or a specific suggestion, not progress on your task.
      Saves a draft only. The user reads it in Lattice and decides whether
      to send it; nothing leaves this machine from this command. Refused
      if the user has switched feedback off in Settings.
`;

function fail(message: string): never {
  process.stderr.write(`lattice feedback: ${message}\n`);
  process.exit(1);
}

export async function runFeedbackCommand(args: string[]): Promise<void> {
  let session: string | undefined;
  let category: string | undefined;
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(`Usage:\n${FEEDBACK_USAGE}`);
      return;
    }
    if (arg === '--session' || arg === '--category') {
      const value = args[++i];
      if (!value) fail(`${arg} needs a value.`);
      if (arg === '--session') session = value;
      else category = value;
      continue;
    }
    if (arg.startsWith('--')) fail(`unknown flag ${arg}.\n\nUsage:\n${FEEDBACK_USAGE}`);
    words.push(arg);
  }
  const message = words.join(' ');
  if (!message.trim()) fail(`no message.\n\nUsage:\n${FEEDBACK_USAGE}`);

  const { host, port } = readServerAddress();
  let response: Response;
  try {
    response = await fetch(`http://${host}:${port}/api/feedback/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...serverAuthHeaders() },
      body: JSON.stringify({ source: 'agent', message, category, conversationId: session, screen: 'cli' }),
    });
  } catch (error) {
    fail(`could not reach the Lattice server at ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!response.ok) fail(body.error ?? `the server answered ${response.status}.`);
  process.stdout.write(
    `Saved feedback draft ${body.id} for the user to review. Nothing has been sent; only the user can send it. `
    + (session ? 'It appears as a card in the chat they are reading.\n' : 'It is listed in Settings → General.\n'),
  );
}
