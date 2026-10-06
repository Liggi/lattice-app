/**
 * A server keeps a running daemon only when it was started with the code and
 * Claude settings the server would start it with.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { daemonIdentity } from '../../src/process-daemon/daemon-identity.js';

function tree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-identity-'));
  fs.mkdirSync(path.join(dir, 'daemon'));
  fs.mkdirSync(path.join(dir, 'shared'));
  fs.writeFileSync(path.join(dir, 'daemon', 'index.ts'), "import { a } from './a.js';\nimport type {\n  T,\n} from '../shared/types.js';\nawait import('../shared/b.js');\n");
  fs.writeFileSync(path.join(dir, 'shared', 'types.ts'), 'export type T = 1;\n');
  fs.writeFileSync(path.join(dir, 'daemon', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'shared', 'b.ts'), 'export const b = 1;\n');
  fs.writeFileSync(path.join(dir, 'shared', 'unrelated.ts'), 'export const c = 1;\n');
  return dir;
}

describe('daemon identity', () => {
  it('changes with any file the daemon loads and with the settings env, and nothing else', () => {
    const dir = tree();
    const entry = path.join(dir, 'daemon', 'index.ts');
    const base = daemonIdentity(entry, { A: '1' });

    fs.appendFileSync(path.join(dir, 'shared', 'unrelated.ts'), '// edit\n');
    fs.appendFileSync(path.join(dir, 'shared', 'types.ts'), 'export type U = 2;\n');
    expect(daemonIdentity(entry, { A: '1' })).toBe(base);

    expect(daemonIdentity(entry, { A: '2' })).not.toBe(base);

    fs.appendFileSync(path.join(dir, 'shared', 'b.ts'), '// edit\n');
    expect(daemonIdentity(entry, { A: '1' })).not.toBe(base);
  });
});
