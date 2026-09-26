import { defineConfig } from '@playwright/test';

const TEST_PORT = Number(process.env.TEST_PORT ?? '4200');

export default defineConfig({
  testDir: './contracts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 30000,
  expect: {
    timeout: 15000,
  },
  use: {
    baseURL: `http://localhost:${TEST_PORT}`,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'npx tsx test/behavioral/server.ts',
    port: TEST_PORT,
    timeout: 30000,
    reuseExistingServer: true,
    cwd: '../..',
  },
});
