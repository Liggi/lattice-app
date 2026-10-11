#!/usr/bin/env node
// lattice-plugin-build [--server src/server.ts] [--web src/web.tsx] [--css src/web.css] [--outdir dist]
import { buildLatticePlugin } from './build.mjs';

const opts = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const key = args[i].replace(/^--/, '');
  if (!['server', 'web', 'css', 'outdir'].includes(key) || args[i + 1] === undefined) {
    console.error(`lattice-plugin-build: unknown or empty flag ${args[i]}`);
    process.exit(2);
  }
  opts[key] = args[i + 1];
}
await buildLatticePlugin(opts);
