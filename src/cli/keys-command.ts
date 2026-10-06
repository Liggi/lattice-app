/**
 * `lattice keys import <file>` — save API keys someone sent the user as a
 * file, so their project's agent can set them up without the keys passing
 * through the chat.
 *
 * The keys go through the same request as Save in Settings → Providers, so
 * saving them has the same effects there. Nothing this command prints
 * contains a key, including its errors.
 */

import fs from 'fs';
import { parseJson } from '../utils/json.js';
import { serverAuthHeaders } from './server-auth.js';
import { readServerAddress } from './session-commands.js';

export const KEYS_USAGE = `  lattice keys import <file>
      Save the API keys in a key file, as Save does in Settings → Providers,
      then delete the file. The file is JSON with either or both of
      {"anthropic": "sk-ant-…", "typesafe": "…"}; a key left out is skipped.
      Use this for any key file; never cat, print or paste one.
`;

/** Field in the file → the Settings section its key is saved under. */
const KEY_FIELDS = {
  anthropic: 'Anthropic key',
  typesafe: 'TypeSafe key',
} as const;

type KeyField = keyof typeof KEY_FIELDS;
export type KeyFile = Partial<Record<KeyField, string>>;

/**
 * The keys in a key file's text. Throws on anything else, with a message that
 * never quotes the file: the JSON parser's own message can include its contents.
 */
export function parseKeyFile(text: string): KeyFile {
  let parsed: unknown;
  try {
    parsed = parseJson(text);
  } catch {
    throw new Error('the file is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the file must be a JSON object like {"anthropic": "…", "typesafe": "…"}.');
  }
  const keys: KeyFile = {};
  for (const [field, value] of Object.entries(parsed)) {
    if (!(field in KEY_FIELDS)) {
      // Not named: a mistyped file could have a key where a field name goes.
      throw new Error(`the file has a field other than ${Object.keys(KEY_FIELDS).join(' and ')}.`);
    }
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string') throw new Error(`"${field}" must be a string.`);
    if (value.trim()) keys[field as KeyField] = value.trim();
  }
  if (Object.keys(keys).length === 0) throw new Error('the file holds no keys.');
  return keys;
}

/** What the server answers about each section after a save: whether a key is now set. */
type SavedConfig = Partial<Record<KeyField, { apiKeyConfigured?: boolean }>>;

/**
 * Reads the file, saves its keys, and deletes it once the server confirms
 * every key is saved. Returns the names of what was saved. A bad file or a
 * failed save throws and leaves the file where it was.
 */
export async function importKeyFile(file: string, save: (update: Record<string, { apiKey: string }>) => Promise<SavedConfig>): Promise<string[]> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(code === 'ENOENT' ? `no file at ${file}.` : `could not read ${file} (${code ?? 'unknown error'}).`);
  }
  const keys = parseKeyFile(text);
  const fields = Object.keys(keys) as KeyField[];
  const saved = await save(Object.fromEntries(fields.map((field) => [field, { apiKey: keys[field] as string }])));
  const missing = fields.filter((field) => saved[field]?.apiKeyConfigured !== true);
  if (missing.length > 0) {
    throw new Error(`the server did not confirm the ${missing.map((field) => KEY_FIELDS[field]).join(' and ')} was saved; the file was left in place.`);
  }
  fs.rmSync(file);
  return fields.map((field) => KEY_FIELDS[field]);
}

/** The request Settings → Providers makes when you press Save. */
async function saveToServer(update: Record<string, { apiKey: string }>): Promise<SavedConfig> {
  const { host, port } = readServerAddress();
  let response: Response;
  try {
    response = await fetch(`http://${host}:${port}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...serverAuthHeaders() },
      body: JSON.stringify(update),
    });
  } catch (error) {
    throw new Error(`could not reach the Lattice server at ${host}:${port} (${error instanceof Error ? error.message : String(error)}); the file was left in place.`);
  }
  const body = (await response.json().catch(() => ({}))) as SavedConfig & { error?: string };
  if (!response.ok) throw new Error(`${body.error ?? `the server answered ${response.status}`}; the file was left in place.`);
  return body;
}

function fail(message: string): never {
  process.stderr.write(`lattice keys: ${message}\n`);
  process.exit(1);
}

export async function runKeysCommand(args: string[]): Promise<void> {
  const [verb, file, ...rest] = args;
  if (verb === '-h' || verb === '--help' || !verb) {
    process.stdout.write(`Usage:\n${KEYS_USAGE}`);
    return;
  }
  if (verb !== 'import' || !file || rest.length > 0) fail(`expected one file.\n\nUsage:\n${KEYS_USAGE}`);
  try {
    const saved = await importKeyFile(file, saveToServer);
    process.stdout.write(`Saved ${saved.join(', ')}. Deleted ${file}.\n`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
