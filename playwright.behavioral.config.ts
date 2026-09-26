import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/behavioral/contracts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: 30000,
  expect: {
    timeout: 10000,
  },
  use: {
    baseURL: 'http://localhost:4200',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'npx tsx test/behavioral/server.ts',
    port: 4200,
    timeout: 30000,
    reuseExistingServer: !process.env.CI,
  },
});
