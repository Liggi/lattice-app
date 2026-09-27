import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClaudeHistoryReader } from '../../src/services/sessions/claude-history-reader.js';
import type { SessionInfoService } from '../../src/services/sessions/session-info-service.js';

describe('ClaudeHistoryReader.listSessionDirectories', () => {
  let home: string;
  let originalHome: string | undefined;
  let projects: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'lattice-session-dirs-'));
    process.env.HOME = home;
    projects = join(home, '.claude', 'projects');
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  function session(project: string, id: string, lines: object[], mtime = new Date('2026-09-01T10:00:00Z')): string {
    mkdirSync(join(projects, project), { recursive: true });
    const file = join(projects, project, `${id}.jsonl`);
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    utimesSync(file, mtime, mtime);
    return file;
  }

  const reader = () => new ClaudeHistoryReader({} as SessionInfoService);

  it('takes the working directory from the first entry that has one, and last activity from the mtime', async () => {
    session('-Users-me-app', 's1', [
      { type: 'queue-operation', operation: 'enqueue' },
      { type: 'user', cwd: '/Users/me/my-app', message: { role: 'user', content: 'hi' } },
      { type: 'user', cwd: '/elsewhere', message: { role: 'user', content: 'later' } },
    ], new Date('2026-09-02T12:00:00Z'));

    expect(await reader().listSessionDirectories()).toEqual([
      { projectPath: '/Users/me/my-app', updatedAt: '2026-09-02T12:00:00.000Z' },
    ]);
  });

  it('falls back to the project folder name when no entry near the start has a cwd', async () => {
    session('-Users-me-app', 's1', [{ type: 'summary', summary: 'no cwd here' }]);

    expect((await reader().listSessionDirectories())[0].projectPath).toBe('/Users/me/app');
  });

  it('finds a cwd past the first read chunk without reading the whole transcript', async () => {
    const padding = { type: 'attachment', blob: 'x'.repeat(200 * 1024) };
    session('-p', 's1', [padding, { type: 'user', cwd: '/deep/cwd' }, padding]);

    expect((await reader().listSessionDirectories())[0].projectPath).toBe('/deep/cwd');
  });

  it('keeps a multi-byte character that straddles a read chunk boundary', async () => {
    // Puts the first byte of 'é' at offset 65535, the last byte of the first chunk.
    const padding = { type: 'a', blob: 'x'.repeat(65489) };
    session('-p', 's1', [padding, { type: 'user', cwd: '/é/app' }]);

    expect((await reader().listSessionDirectories())[0].projectPath).toBe('/é/app');
  });

  it('gives up at 1 MB and falls back to the project folder name', async () => {
    session('-Users-me-app', 's1', [{ type: 'attachment', blob: 'x'.repeat(1100 * 1024) }, { type: 'user', cwd: '/too/deep' }]);

    expect((await reader().listSessionDirectories())[0].projectPath).toBe('/Users/me/app');
  });

  it('re-reads a file only when its mtime changes', async () => {
    const r = reader();
    const file = session('-p', 's1', [{ type: 'user', cwd: '/first' }]);
    expect((await r.listSessionDirectories())[0].projectPath).toBe('/first');

    writeFileSync(file, JSON.stringify({ type: 'user', cwd: '/second' }) + '\n');
    const same = new Date('2026-09-01T10:00:00Z');
    utimesSync(file, same, same);
    expect((await r.listSessionDirectories())[0].projectPath).toBe('/first');

    const later = new Date('2026-09-03T10:00:00Z');
    utimesSync(file, later, later);
    expect((await r.listSessionDirectories())[0].projectPath).toBe('/second');
  });
});
