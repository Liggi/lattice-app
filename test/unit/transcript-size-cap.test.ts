import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, ftruncateSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClaudeHistoryReader, MAX_PARSED_TRANSCRIPT_BYTES } from '../../src/services/sessions/claude-history-reader.js';
import type { SessionInfoService } from '../../src/services/sessions/session-info-service.js';

describe('ClaudeHistoryReader transcript size cap', () => {
  let home: string;
  let originalHome: string | undefined;
  let project: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'lattice-transcript-cap-'));
    process.env.HOME = home;
    project = join(home, '.claude', 'projects', '-p');
    mkdirSync(project, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  const reader = () => new ClaudeHistoryReader({} as SessionInfoService);

  it('refuses a transcript over the cap with a typed error instead of reading it', async () => {
    // Sparse: the size is real to stat, but no disk is written and nothing
    // could be parsed if the reader tried.
    const fd = openSync(join(project, 'huge.jsonl'), 'w');
    ftruncateSync(fd, MAX_PARSED_TRANSCRIPT_BYTES + 1);
    closeSync(fd);

    await expect(reader().fetchConversationDirect('huge')).rejects.toMatchObject({
      code: 'TRANSCRIPT_TOO_LARGE',
      statusCode: 413,
    });
  });

  it('still parses a transcript under the cap', async () => {
    const lines = [
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'small', timestamp: '2026-09-27T10:00:00Z', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'small', timestamp: '2026-09-27T10:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    ];
    writeFileSync(join(project, 'small.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');

    const { messages } = await reader().fetchConversationDirect('small');
    expect(messages.map((message) => message.uuid)).toEqual(['u1', 'a1']);
  });
});
