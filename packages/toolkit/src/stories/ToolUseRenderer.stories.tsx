import type { Meta, StoryObj } from '@storybook/react';
import { ToolUseRenderer } from '../components/ToolUseRenderer';

const meta: Meta<typeof ToolUseRenderer> = {
  title: 'Integration/ToolUseRenderer',
  component: ToolUseRenderer,
};

export default meta;
type Story = StoryObj<typeof ToolUseRenderer>;

export const ReadFile: Story = {
  args: {
    toolUse: { type: 'tool_use', id: '1', name: 'Read', input: { file_path: '/project/src/app.tsx' } },
    toolResult: { status: 'completed', result: '1\timport React from "react";\n2\t\n3\texport default function App() {\n4\t  return <h1>Hello</h1>;\n5\t}' },
    workingDirectory: '/project',
  },
};

export const ErrorResult: Story = {
  args: {
    toolUse: { type: 'tool_use', id: '2', name: 'WebFetch', input: { url: 'https://broken.example.com/api' } },
    toolResult: { status: 'completed', result: 'Connection refused: ECONNREFUSED 127.0.0.1:443', is_error: true },
  },
};

export const MultiLineError: Story = {
  args: {
    toolUse: { type: 'tool_use', id: '3', name: 'Bash', input: { command: 'npm run build' } },
    toolResult: {
      status: 'completed',
      is_error: true,
      result: 'Error: Module not found\n  at resolveModule (webpack/lib/resolve.js:42)\n  at compile (webpack/lib/compiler.js:108)\n  at run (webpack/lib/cli.js:23)',
    },
  },
};

export const PendingTool: Story = {
  args: {
    toolUse: { type: 'tool_use', id: '4', name: 'Grep', input: { pattern: 'TODO', path: './src' } },
    isStreaming: true,
  },
};

export const McpTool: Story = {
  args: {
    toolUse: { type: 'tool_use', id: '5', name: 'mcp__slack__conversations_history', input: { channel: 'C01234' } },
    toolResult: { status: 'completed', result: '{"messages": [{"text": "Hey team, deploy looks good", "user": "U123"}]}' },
  },
};

export const CustomRenderer: Story = {
  args: {
    toolUse: { type: 'tool_use', id: '6', name: 'MyCustomTool', input: { data: 'test' } },
    toolResult: { status: 'completed', result: 'Custom result data' },
    customRenderers: {
      MyCustomTool: ({ result }) => (
        <div className="p-4 rounded-lg border-2 border-dashed border-pink-500/30 bg-pink-500/5">
          <div className="text-xs text-pink-400 font-bold mb-1">Custom Renderer</div>
          <div className="text-sm text-stone-600 dark:text-zinc-300">{result}</div>
        </div>
      ),
    },
  },
};

export const ToolSearchSelect: Story = {
  name: 'ToolSearch (select: hidden)',
  args: {
    toolUse: { type: 'tool_use', id: '7', name: 'ToolSearch', input: { query: 'select:mcp__slack__send' } },
    toolResult: { status: 'completed', result: '[{"tool_name":"mcp__slack__send"}]' },
  },
};
