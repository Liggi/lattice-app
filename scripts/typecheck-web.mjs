#!/usr/bin/env node
// Web typecheck. With LATTICE_TOOLKIT_SRC set (the same variable vite.config.mts
// reads), @liggi/agent-ui-toolkit is checked from that source tree instead of
// the build installed in node_modules. React's types are pinned to ours so the
// toolkit source doesn't bring in a second copy.
//   LATTICE_TOOLKIT_SRC=/path/to/agent-ui-toolkit/src pnpm typecheck:web

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = join(root, 'node_modules', '.bin', 'tsc');
const toolkitSrc = process.env.LATTICE_TOOLKIT_SRC;

let project = join(root, 'tsconfig.web.json');
let tempDir;
if (toolkitSrc) {
  const entry = join(resolve(toolkitSrc), 'index.ts');
  if (!existsSync(entry)) {
    console.error(`LATTICE_TOOLKIT_SRC has no index.ts: ${entry}`);
    process.exit(1);
  }
  const types = (name) => join(root, 'node_modules', '@types', name);
  tempDir = mkdtempSync(join(tmpdir(), 'lattice-typecheck-web-'));
  project = join(tempDir, 'tsconfig.json');
  writeFileSync(project, JSON.stringify({
    extends: join(root, 'tsconfig.web.json'),
    compilerOptions: {
      baseUrl: root,
      paths: {
        '@/*': ['src/*'],
        '@liggi/agent-ui-toolkit': [entry],
        react: [join(types('react'), 'index.d.ts')],
        'react/*': [join(types('react'), '*')],
        'react-dom': [join(types('react-dom'), 'index.d.ts')],
        'react-dom/*': [join(types('react-dom'), '*')],
      },
    },
  }, null, 2));
  console.log(`checking against toolkit source ${toolkitSrc}`);
}

const result = spawnSync(tsc, ['--noEmit', '-p', project], { stdio: 'inherit' });
if (tempDir) rmSync(tempDir, { recursive: true, force: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('web typecheck passed');
