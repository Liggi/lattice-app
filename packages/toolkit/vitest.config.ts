import { defineConfig } from 'vitest/config';

// Own config so vitest does not pick up the app's from the repo root.
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
