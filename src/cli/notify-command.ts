/**
 * `lattice notify --session <conv> "<message>"` — an agent asks the user to
 * come and look at its conversation, on every device that has notifications on.
 */

import { serverAuthHeaders } from './server-auth.js';
import { readServerAddress } from './session-commands.js';

export const NOTIFY_USAGE = `  lattice notify --session <conv-id> "<message>"
      Notify the user's phone and computers that this conversation has something
      for them to look at now, mid-turn: a result ready, a decision only they
      can make. Every turn that ends on a reply already notifies them, so never
      use this for that. Not sent while they are looking at the conversation.
`;

function fail(message: string): never {
  process.stderr.write(`lattice notify: ${message}\n`);
  process.exit(1);
}

export async function runNotifyCommand(args: string[]): Promise<void> {
  let session: string | undefined;
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(`Usage:\n${NOTIFY_USAGE}`);
      return;
    }
    if (arg === '--session') {
      session = args[++i];
      if (!session) fail('--session needs a value.');
      continue;
    }
    if (arg.startsWith('--')) fail(`unknown flag ${arg}.\n\nUsage:\n${NOTIFY_USAGE}`);
    words.push(arg);
  }
  const message = words.join(' ').trim();
  if (!session) fail(`--session is required.\n\nUsage:\n${NOTIFY_USAGE}`);
  if (!message) fail(`no message.\n\nUsage:\n${NOTIFY_USAGE}`);

  const { host, port } = readServerAddress();
  let response: Response;
  try {
    response = await fetch(`http://${host}:${port}/api/notifications/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...serverAuthHeaders() },
      body: JSON.stringify({ sessionId: session, message }),
    });
  } catch (error) {
    fail(`could not reach the Lattice server at ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = (await response.json().catch(() => ({}))) as {
    sent?: number; failed?: number; skipped?: string; error?: string;
  };
  if (!response.ok) fail(body.error ?? `the server answered ${response.status}.`);
  const outcome: Record<string, string> = {
    watching: 'Not sent: the user is looking at this conversation now.',
    disabled: 'Not sent: the user has switched notifications off.',
    'no-devices': 'Not sent: the user has not turned notifications on for any device.',
  };
  process.stdout.write(
    body.skipped
      ? `${outcome[body.skipped] ?? `Not sent: ${body.skipped}.`}\n`
      : `Sent to ${body.sent} device${body.sent === 1 ? '' : 's'}${body.failed ? ` (${body.failed} failed)` : ''}.\n`,
  );
}
