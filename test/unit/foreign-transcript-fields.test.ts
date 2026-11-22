/**
 * A session that ran on a translating endpoint (Gemini via LiteLLM) keeps
 * fields in its transcript that Anthropic refuses; resuming on Claude drops
 * them and leaves every other line as it was.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { removeForeignTranscriptFields, withoutForeignFields } from '../../src/process-daemon/foreign-transcript-fields.js';

const toolUse = (extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' }, ...extra }] },
});

describe('foreign transcript fields', () => {
  it('drops provider_specific_fields from content blocks and nothing else', () => {
    const cleaned = withoutForeignFields(toolUse({ provider_specific_fields: { signature: 'abc' } }));
    expect(cleaned).toBe(toolUse());
    expect(withoutForeignFields(toolUse())).toBeNull();
    // The key named inside a tool result's text is left alone.
    expect(withoutForeignFields(JSON.stringify({ message: { content: 'provider_specific_fields' } }))).toBeNull();
  });

  it("rewrites the session's transcript in its cwd's project folder", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-fields-'));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = home;
    try {
      const dir = path.join(home, 'projects', '-work-repo');
      fs.mkdirSync(dir, { recursive: true });
      const user = '{"type":"user","message":{"role":"user","content":"hi"}}';
      const file = path.join(dir, 's1.jsonl');
      fs.writeFileSync(file, [user, toolUse({ provider_specific_fields: { signature: 'abc' } }), ''].join('\n'));

      expect(await removeForeignTranscriptFields('s1', '/work/repo')).toBe(1);
      expect(fs.readFileSync(file, 'utf-8')).toBe([user, toolUse(), ''].join('\n'));
      expect(await removeForeignTranscriptFields('s1', '/work/repo')).toBe(0);
      expect(await removeForeignTranscriptFields('missing', '/work/repo')).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
