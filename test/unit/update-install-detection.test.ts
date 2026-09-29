import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectInstall } from '@/services/updates/update-service.js';

const made: string[] = [];

/** A lattice-app package at `rel` under a temp dir, with an npm-style bin link when asked. */
function fakeInstall(rel: string, binLink = false): string {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-install-')));
  made.push(base);
  const root = path.join(base, rel);
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'cli.js'), '');
  if (binLink) {
    fs.mkdirSync(path.join(base, 'bin'));
    fs.symlinkSync(path.join(root, 'dist', 'cli.js'), path.join(base, 'bin', 'lattice-app'));
  }
  return root;
}

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('detectInstall', () => {
  it('treats a checkout outside node_modules as source, with nothing to offer', () => {
    expect(detectInstall(fakeInstall('src/lattice-app'))).toMatchObject({ kind: 'source', canUpdate: false, command: null });
  });

  it('can update an npm -g install whose bin link points at it', () => {
    const info = detectInstall(fakeInstall('lib/node_modules/lattice-app', true));
    expect(info).toMatchObject({ kind: 'npm-global', canUpdate: true });
  });

  it('does not claim an npm layout without the bin link', () => {
    expect(detectInstall(fakeInstall('lib/node_modules/lattice-app'))).toMatchObject({ kind: 'other', canUpdate: false });
  });

  it('gives npx users the npx command', () => {
    expect(detectInstall(fakeInstall('.npm/_npx/abc123/node_modules/lattice-app'))).toMatchObject({
      kind: 'npx',
      canUpdate: false,
      command: 'npx lattice-app@latest',
    });
  });

  it('gives a pnpm global install the command rather than updating it', () => {
    expect(detectInstall(fakeInstall('pnpm/global/5/node_modules/.pnpm/lattice-app@0.4.3/node_modules/lattice-app'))).toMatchObject({
      kind: 'other',
      canUpdate: false,
    });
  });
});
