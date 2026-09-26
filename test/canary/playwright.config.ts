/**
 * Canary test config — exercises the real Anthropic API through the full stack.
 *
 * Requires ANTHROPIC_API_KEY in the environment. These tests are NOT part
 * of the standard `pnpm test` suite — run them explicitly with `pnpm test:canary`.
 *
 * Uses the same test server as behavioral tests (LatticeServer + ProcessDaemon
 * + agent stub). The only difference: ANTHROPIC_API_KEY is present, so the
 * InsightsTrigger makes real API calls instead of silently skipping.
 */

import dotenv from 'dotenv';
import { defineConfig } from '@playwright/test';
import path from 'path';

// Load .env from project root (gitignored — contains ANTHROPIC_API_KEY)
dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env') });

const PORT = 4200;

export default defineConfig({
  testDir: path.resolve(import.meta.dirname, '.'),
  testMatch: '**/*.spec.ts',

  // Canary tests call real APIs — generous timeouts
  timeout: 60_000,
  expect: { timeout: 45_000 },

  // Sequential — one session at a time
  workers: 1,
  fullyParallel: false,

  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
  },

  projects: [
    {
      name: 'canary',
      use: { browserName: 'chromium' },
    },
  ],

  webServer: {
    command: `npx tsx test/behavioral/server.ts`,
    cwd: path.resolve(import.meta.dirname, '../..'),
    port: PORT,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
