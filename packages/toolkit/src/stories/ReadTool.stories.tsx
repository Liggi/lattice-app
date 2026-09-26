import type { Meta, StoryObj } from '@storybook/react';
import { ReadTool } from '../components/tools/ReadTool';

const meta: Meta<typeof ReadTool> = {
  title: 'Tools/ReadTool',
  component: ReadTool,
};

export default meta;
type Story = StoryObj<typeof ReadTool>;

export const ShortFile: Story = {
  args: {
    input: { file_path: '/Users/alex/project/src/index.ts' },
    result: '1\timport React from "react";\n2\t\n3\texport function App() {\n4\t  return <div>Hello</div>;\n5\t}',
    workingDirectory: '/Users/alex/project',
  },
};

export const LongFile: Story = {
  args: {
    input: { file_path: '/Users/alex/project/src/utils/helpers.ts', offset: 0, limit: 50 },
    result: Array.from({ length: 30 }, (_, i) =>
      `${i + 1}\t${'const ' + String.fromCharCode(97 + (i % 26)) + ' = ' + i + ';'}`
    ).join('\n'),
    workingDirectory: '/Users/alex/project',
  },
};

export const EmptyResult: Story = {
  args: {
    input: { file_path: '/Users/alex/project/empty.txt' },
    result: '',
  },
};

export const PythonFile: Story = {
  args: {
    input: { file_path: 'app/main.py' },
    result: '1\tdef hello():\n2\t    print("Hello, world!")\n3\t\n4\tif __name__ == "__main__":\n5\t    hello()',
  },
};
