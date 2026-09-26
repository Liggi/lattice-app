import type { Meta, StoryObj } from '@storybook/react';
import { BashTool } from '../components/tools/BashTool';

const meta: Meta<typeof BashTool> = {
  title: 'Tools/BashTool',
  component: BashTool,
};

export default meta;
type Story = StoryObj<typeof BashTool>;

export const ShortCommand: Story = {
  args: {
    input: { command: 'git status' },
    result: 'On branch main\nnothing to commit, working tree clean',
  },
};

export const LongOutput: Story = {
  args: {
    input: { command: 'npm test', description: 'Running test suite' },
    result: Array.from({ length: 20 }, (_, i) => `  ✓ test case ${i + 1} (${Math.floor(Math.random() * 100)}ms)`).join('\n') + '\n\n  20 passing (1.2s)',
  },
};

export const Pending: Story = {
  args: {
    input: { command: 'pnpm build && pnpm deploy' },
    result: '',
    isPending: true,
  },
};

export const WithDescription: Story = {
  args: {
    input: { command: 'find . -name "*.test.ts" -exec grep -l "describe" {} \\;', description: 'Find test files with describe blocks' },
    result: './src/__tests__/tool-utils.test.ts\n./src/__tests__/language-detection.test.ts',
  },
};

export const ErrorOutput: Story = {
  args: {
    input: { command: 'npm run build' },
    result: 'Error: Cannot find module \'./missing\'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1075:15)\n    at Module._load (node:internal/modules/cjs/loader:920:27)',
  },
};
