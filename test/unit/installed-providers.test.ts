import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { describe, expect, it } from 'vitest';
import { installedProviders } from '../../src/services/sessions/installed-providers.js';
import { buildCoordinatorPreamble } from '../../src/services/sessions/pickup-prompts.js';

function pathWith(...clis: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-providers-'));
  mkdirSync(join(dir, 'bin'));
  for (const cli of clis) writeFileSync(join(dir, 'bin', cli), '', { mode: 0o755 });
  return [join(dir, 'bin'), join(dir, 'empty')].join(delimiter);
}

const preamble = (installed?: Array<'claude' | 'codex'>) =>
  buildCoordinatorPreamble({ conversationId: 'conv-test', workingDirectory: '/w', cli: 'lattice', installedProviders: installed });

describe('the providers a coordinator is told it can dispatch to', () => {
  it('finds each agent CLI on PATH', () => {
    expect(installedProviders(pathWith('codex'))).toEqual(['codex']);
    expect(installedProviders(pathWith('claude', 'codex'))).toEqual(['claude', 'codex']);
    expect(installedProviders(pathWith())).toEqual([]);
  });

  // A Codex-only install dispatched its first worker to Claude Opus, which
  // failed, and then stopped to ask permission to use Codex.
  it('sends every worker to Codex when only Codex is installed', () => {
    expect(preamble(['codex'])).toContain('Only Codex is installed on this machine, so every worker runs with `--provider codex`');
  });

  it('says nothing extra when both are installed', () => {
    expect(preamble(['claude', 'codex'])).not.toContain('is installed on this machine');
  });
});
