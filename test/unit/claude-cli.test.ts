import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findUserClaudeExecutable } from '../../src/services/process/claude-cli.js';

function cliDir(prefix = 'lattice-claude-cli-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, 'claude'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, 'claude'), 0o755);
  return dir;
}

describe('findUserClaudeExecutable', () => {
  it('skips a workspace install: that is a dependency-pinned Claude, not the one the user signed in with', () => {
    const outer = cliDir();
    const workspace = mkdtempSync(join(tmpdir(), 'lattice-ws-'));
    const workspaceBin = join(workspace, 'node_modules', '.bin');
    mkdirSync(workspaceBin, { recursive: true });
    writeFileSync(join(workspaceBin, 'claude'), '#!/bin/sh\nexit 0\n');
    try {
      expect(findUserClaudeExecutable([workspaceBin, outer].join(':'))).toBe(join(outer, 'claude'));
    } finally {
      rmSync(outer, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('takes the first on PATH so a version manager wins over a stale system copy', () => {
    const first = cliDir();
    const second = cliDir();
    try {
      expect(findUserClaudeExecutable([first, second].join(':'))).toBe(join(first, 'claude'));
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });
});
