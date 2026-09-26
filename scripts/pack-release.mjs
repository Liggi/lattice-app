#!/usr/bin/env node
// Builds the npm tarball for `lattice-app` from an already-built checkout
// (`pnpm build`). Usage: pnpm pack:release [destination-dir]
//
// The server imports @liggi/agent-ui-harness at runtime, and the repo links it
// from packages/harness with `workspace:*`. The registry copy of that package
// is older than this code, so the tarball carries the built harness itself as
// a bundled dependency. pnpm refuses bundleDependencies under its isolated
// linker, so this stages a plain folder and runs `npm pack` there.
// The toolkit is only used by the web bundle, which vite already inlines.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dest = resolve(process.argv[2] ?? root);
const HARNESS = '@liggi/agent-ui-harness';

execFileSync(process.execPath, [join(root, 'scripts', 'check-publishable-deps.js')], { stdio: 'inherit' });

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const harnessDir = join(root, 'packages', 'harness');
const harnessPkg = JSON.parse(readFileSync(join(harnessDir, 'package.json'), 'utf8'));

for (const built of ['dist/cli.js', 'dist/web/index.html', 'packages/harness/dist/server/index.js']) {
  if (!existsSync(join(root, built))) {
    console.error(`Missing ${built}: run pnpm build first.`);
    process.exit(1);
  }
}

const stage = mkdtempSync(join(tmpdir(), 'lattice-app-pack-'));
try {
  for (const entry of ['dist', 'data/banners', 'scripts/postinstall.js', 'README.md', 'LICENSE']) {
    cpSync(join(root, entry), join(stage, entry), { recursive: true });
  }
  const vendored = join(stage, 'node_modules', HARNESS);
  mkdirSync(vendored, { recursive: true });
  cpSync(join(harnessDir, 'dist'), join(vendored, 'dist'), { recursive: true });
  writeFileSync(join(vendored, 'package.json'), JSON.stringify(harnessPkg, null, 2) + '\n');

  // What an installer needs: no dev tooling, no workspace specs, and a
  // postinstall that doesn't try to build the workspace packages.
  const release = {
    name: pkg.name,
    version: pkg.version,
    type: pkg.type,
    description: pkg.description,
    main: pkg.main,
    bin: pkg.bin,
    files: pkg.files,
    keywords: pkg.keywords,
    author: pkg.author,
    contributors: pkg.contributors,
    license: pkg.license,
    repository: pkg.repository,
    homepage: pkg.homepage,
    bugs: pkg.bugs,
    engines: pkg.engines,
    scripts: { postinstall: 'node scripts/postinstall.js' },
    dependencies: { ...pkg.dependencies, [HARNESS]: harnessPkg.version },
    bundleDependencies: [HARNESS],
  };
  writeFileSync(join(stage, 'package.json'), JSON.stringify(release, null, 2) + '\n');

  mkdirSync(dest, { recursive: true });
  const out = execFileSync('npm', ['pack', '--pack-destination', dest], { cwd: stage, encoding: 'utf8' });
  console.log(join(dest, out.trim().split('\n').pop()));
} finally {
  rmSync(stage, { recursive: true, force: true });
}
