import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../..');
const writerModule = join(repoRoot, 'src/services/infrastructure/fail-safe-log-writer.ts');

describe('FailSafeLogWriter', () => {
  it('survives failed log writes, reports them on stderr and resumes (regression: ENOSPC on the log file crashed the server, 2026-09-26)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fail-safe-log-'));
    const logPath = join(dir, 'server.jsonl');
    // A directory where the log file should be makes every open fail (EISDIR)
    // until it is removed; a read-only fd makes the write itself fail (EBADF).
    // Run in a child so its stderr can be read.
    mkdirSync(logPath);
    const child = `
      import { openSync, rmdirSync } from 'node:fs';
      import { FailSafeLogWriter } from ${JSON.stringify(writerModule)};
      const file = new FailSafeLogWriter(${JSON.stringify(logPath)});
      file.write('lost 1\\n');
      file.write('lost 2\\n');
      rmdirSync(${JSON.stringify(logPath)});
      file.write('after\\n');
      new FailSafeLogWriter(openSync(${JSON.stringify(writerModule)}, 'r')).write('lost 3\\n');
      process.stdout.write('still running');
    `;
    try {
      const result = spawnSync(join(repoRoot, 'node_modules/.bin/tsx'), ['-e', child], { encoding: 'utf8' });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('still running');
      const notices = result.stderr.trim().split('\n');
      expect(notices).toHaveLength(3);
      expect(notices[0]).toContain(`writes to ${logPath} are failing (EISDIR`);
      expect(notices[1]).toContain(`writes to ${logPath} resumed; 2 log lines dropped since`);
      expect(notices[2]).toMatch(/writes to fd \d+ are failing \(EBADF/);
      expect(readFileSync(logPath, 'utf8')).toBe('after\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
