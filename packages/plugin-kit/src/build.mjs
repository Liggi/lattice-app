/**
 * Builds a Lattice plugin: the server entry for Node, the web entry as one
 * browser module that uses the host's React, and its stylesheet.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const shims = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shims');

/** Points React imports at the host's copy, which Lattice puts on `globalThis.__latticePluginHost`. */
export const hostReact = {
  name: 'lattice-host-react',
  setup(b) {
    const map = {
      react: 'react.cjs',
      'react/jsx-runtime': 'jsx-runtime.cjs',
      'react/jsx-dev-runtime': 'jsx-runtime.cjs',
      'react-dom': 'react-dom.cjs',
    };
    b.onResolve({ filter: /^react(-dom)?(\/jsx-(dev-)?runtime)?$/ }, (args) => (
      map[args.path] ? { path: path.join(shims, map[args.path]) } : undefined
    ));
  },
};

function runTailwind(input, output, cwd) {
  const cliPackage = require.resolve('@tailwindcss/cli/package.json');
  const bin = path.join(path.dirname(cliPackage), require(cliPackage).bin.tailwindcss);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, '-i', input, '-o', output, '--minify'], { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tailwindcss exited ${code}`))));
  });
}

/**
 * @param {{ root?: string, server?: string, web?: string, css?: string, outdir?: string }} opts
 *   Entry paths relative to `root`; outputs are `server.js`, `web.js` and `web.css` in `outdir`.
 */
export async function buildLatticePlugin({ root: rootDir = process.cwd(), server, web, css, outdir = 'dist' }) {
  const root = path.resolve(rootDir);
  const out = path.resolve(root, outdir);
  if (server) {
    await build({
      absWorkingDir: root,
      entryPoints: [server],
      outfile: path.join(out, 'server.js'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      packages: 'external',
      logLevel: 'warning',
    });
  }
  if (web) {
    await build({
      absWorkingDir: root,
      entryPoints: [web],
      outfile: path.join(out, 'web.js'),
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      jsx: 'automatic',
      minify: true,
      plugins: [hostReact],
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'warning',
    });
  }
  if (css) await runTailwind(path.resolve(root, css), path.join(out, 'web.css'), root);
}
