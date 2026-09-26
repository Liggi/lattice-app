import type { Meta, StoryObj } from '@storybook/react';
import { EditTool } from '../components/tools/EditTool';

const meta: Meta<typeof EditTool> = {
  title: 'Tools/EditTool',
  component: EditTool,
};

export default meta;
type Story = StoryObj<typeof EditTool>;

export const SmallEdit: Story = {
  args: {
    input: {
      file_path: '/Users/alex/project/src/app.tsx',
      old_string: 'const name = "World";',
      new_string: 'const name = "Claude";',
    },
    result: 'Edit applied successfully',
    workingDirectory: '/Users/alex/project',
  },
};

export const MultiLineEdit: Story = {
  args: {
    input: {
      file_path: '/Users/alex/project/src/config.ts',
      old_string: 'export const config = {\n  debug: false,\n  port: 3000,\n};',
      new_string: 'export const config = {\n  debug: true,\n  port: 8080,\n  host: "localhost",\n  logLevel: "verbose",\n};',
    },
    result: 'Edit applied successfully',
    workingDirectory: '/Users/alex/project',
  },
};

export const MultiEdit: Story = {
  args: {
    input: {
      file_path: '/Users/alex/project/src/utils.ts',
      edits: [
        { old_string: 'function add(a, b)', new_string: 'function add(a: number, b: number): number' },
        { old_string: 'function sub(a, b)', new_string: 'function sub(a: number, b: number): number' },
      ],
    },
    result: 'MultiEdit applied',
    isMultiEdit: true,
    workingDirectory: '/Users/alex/project',
  },
};
