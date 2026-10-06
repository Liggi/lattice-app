/**
 * `lattice keys import <file>`: a coordinator saves keys someone sent the
 * user as a file, without the keys passing through the chat.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importKeyFile, parseKeyFile } from '../../src/cli/keys-command.js';

const ANTHROPIC = 'sk-ant-test-0000';
const TYPESAFE = 'ts-test-1111';

let tmpRoot: string;
let file: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'keys import '));
  file = path.join(tmpRoot, 'lattice-keys.json');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Answers as the config route does: each section saved says its key is set. */
function savedAs(sent: Record<string, { apiKey: string }>[]) {
  return async (update: Record<string, { apiKey: string }>) => {
    sent.push(update);
    return Object.fromEntries(Object.keys(update).map((field) => [field, { apiKeyConfigured: true }]));
  };
}

function errorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected an error');
}

describe('keys import', () => {
  it('saves both keys in one Settings request and deletes the file', async () => {
    fs.writeFileSync(file, JSON.stringify({ anthropic: ANTHROPIC, typesafe: ` ${TYPESAFE}\n` }));
    const sent: Record<string, { apiKey: string }>[] = [];

    expect(await importKeyFile(file, savedAs(sent))).toEqual(['Anthropic key', 'TypeSafe key']);
    expect(sent).toEqual([{ anthropic: { apiKey: ANTHROPIC }, typesafe: { apiKey: TYPESAFE } }]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('skips a key the file leaves out or leaves empty', async () => {
    fs.writeFileSync(file, JSON.stringify({ typesafe: TYPESAFE, anthropic: '' }));
    const sent: Record<string, { apiKey: string }>[] = [];

    expect(await importKeyFile(file, savedAs(sent))).toEqual(['TypeSafe key']);
    expect(sent).toEqual([{ typesafe: { apiKey: TYPESAFE } }]);
  });

  it('refuses a bad file without quoting it', () => {
    const cases = [
      `{"anthropic": "${ANTHROPIC}",}`,
      `["${ANTHROPIC}"]`,
      `{"${ANTHROPIC}": "x"}`,
      '{"anthropic": 42}',
      '{}',
    ];
    for (const text of cases) {
      const message = errorOf(() => parseKeyFile(text));
      expect(message).not.toContain(ANTHROPIC);
    }
  });

  it('leaves the file in place when the save fails or is not confirmed', async () => {
    fs.writeFileSync(file, JSON.stringify({ anthropic: ANTHROPIC, typesafe: TYPESAFE }));

    await expect(importKeyFile(file, async () => { throw new Error('could not reach the Lattice server'); })).rejects.toThrow('could not reach');
    expect(fs.existsSync(file)).toBe(true);

    const error = await importKeyFile(file, async () => ({ anthropic: { apiKeyConfigured: true } })).catch((e: Error) => e);
    expect((error as Error).message).toContain('TypeSafe key');
    expect((error as Error).message).not.toContain(TYPESAFE);
    expect(fs.existsSync(file)).toBe(true);
  });
});
