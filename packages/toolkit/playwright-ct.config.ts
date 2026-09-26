import { defineConfig, devices } from '@playwright/experimental-ct-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  testDir: './src',
  testMatch: '**/*.ct.tsx',
  use: {
    ...devices['Desktop Chrome'],
    ctViteConfig: {
      plugins: [tailwindcss()],
    },
  },
});
