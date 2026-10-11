/**
 * `lattice plugin <id> <command>` — an agent hands something to a plugin:
 * the --session it is working in, every other `--name value` flag, and
 * standard input verbatim. The plugin's answer is printed for the agent.
 */

import { serverAuthHeaders } from './server-auth.js';
import { readServerAddress } from './session-commands.js';

export const PLUGIN_USAGE = `  lattice plugin <plugin-id> <command> --session <conv-id> [--<name> <value>…] [< input]
      Run a command a Lattice plugin offers to agents. Text on standard input
      (a heredoc) is passed as it is. Use only when the plugin's instructions
      name the command.
`;

function fail(message: string): never {
  process.stderr.write(`lattice plugin: ${message}\n`);
  process.exit(1);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

export async function runPluginCommand(args: string[]): Promise<void> {
  if (args[0] === '-h' || args[0] === '--help' || args.length < 2) {
    process.stdout.write(`Usage:\n${PLUGIN_USAGE}`);
    if (args.length < 2 && args[0] !== '-h' && args[0] !== '--help') process.exit(1);
    return;
  }
  const [pluginId, command, ...rest] = args;
  let session: string | undefined;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--') || arg.length < 3) fail(`expected a --flag, got "${arg}".\n\nUsage:\n${PLUGIN_USAGE}`);
    const value = rest[++i];
    if (value === undefined) fail(`${arg} needs a value.`);
    if (arg === '--session') session = value;
    else flags[arg.slice(2)] = value;
  }
  if (!session) fail('--session is required: the conversation you are working in.');

  const text = await readStdin();
  const { host, port } = readServerAddress();
  let response: Response;
  try {
    response = await fetch(`http://${host}:${port}/api/plugins/${encodeURIComponent(pluginId)}/commands/${encodeURIComponent(command)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...serverAuthHeaders() },
      body: JSON.stringify({ session, args: flags, text }),
    });
  } catch (error) {
    fail(`could not reach the Lattice server at ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = (await response.json().catch(() => ({}))) as { output?: string; error?: string };
  if (!response.ok) fail(body.error ?? `the server answered ${response.status}.`);
  if (body.output) process.stdout.write(body.output.endsWith('\n') ? body.output : `${body.output}\n`);
}
