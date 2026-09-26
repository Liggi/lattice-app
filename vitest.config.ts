import { defineConfig } from 'vitest/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// Do not inherit a production React build from the caller's shell. React's
// production bundle intentionally omits act(), which makes DOM unit tests fail
// before they exercise the component under test.
process.env.NODE_ENV = 'test';

// Nor the caller's Lattice config: a `user.name` there renames the user in
// every agent-facing line the tests assert on. Tests that need a config dir
// still set their own.
process.env.LATTICE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-unit-config-'));

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    root: '.',
    include: ['test/unit/**/*.test.{ts,tsx}'],
    testTimeout: 10000,
    // Unit tests run in Node even when a file opts into happy-dom with
    // `@vitest-environment`. Without this, those files get Vite's *web*
    // transform, which replaces every Node builtin — `fs`, `os`, `path`,
    // `stream`, `node:`-prefixed or not — with a browser stub whose exports are
    // all undefined. Files failed at collection, before a single assertion ran.
    transformMode: {
      ssr: [/test\/unit\//],
    },
  },
  // The app builds with @vitejs/plugin-react, i.e. the automatic JSX runtime, so
  // components do not import React. Without this the test transform falls back to
  // React.createElement and every rendered component dies with "React is not defined".
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    }
  }
});
