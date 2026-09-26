import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { TaskTool } from '../components/tools/TaskTool';

const meta: Meta<typeof TaskTool> = {
  title: 'Tools/TaskTool',
  component: TaskTool,
};

export default meta;
type Story = StoryObj<typeof TaskTool>;

export const WithResult: Story = {
  args: {
    input: { description: 'Analyze the authentication flow', subagent_type: 'Explore' },
    result: 'Found 3 auth-related files:\n- src/auth/middleware.ts\n- src/auth/providers.ts\n- src/auth/session.ts\n\nThe auth flow uses JWT tokens with refresh rotation.',
    toolUseId: 'tool-1',
  },
};

export const Running: Story = {
  args: {
    input: { description: 'Refactor database queries for performance', subagent_type: 'general-purpose' },
    result: '',
    toolUseId: 'tool-2',
    isPending: true,
    isStreaming: true,
  },
};

export const WithChildren: Story = {
  args: {
    input: { description: 'Search codebase for authentication patterns' },
    result: '',
    toolUseId: 'tool-3',
    childrenMessages: {
      'tool-3': [
        { id: 'c1', messageId: 'c1', type: 'assistant' as const, content: [{ type: 'text', text: 'Let me search for auth patterns...' }], timestamp: new Date().toISOString() },
        { id: 'c2', messageId: 'c2', type: 'assistant' as const, content: [{ type: 'tool_use', id: 'inner-1', name: 'Grep', input: { pattern: 'authenticate' } }], timestamp: new Date().toISOString() },
      ],
    },
    renderChildMessage: (msg) => (
      <div className="text-xs text-stone-500 dark:text-zinc-400 py-1">
        {typeof msg.content === 'string' ? msg.content : '[tool block]'}
      </div>
    ),
  },
};

export const TeamTask: Story = {
  args: {
    input: { description: 'Implement caching layer', team_name: 'backend-crew', name: 'Cache Agent' },
    result: 'Redis caching implemented for /api/sessions endpoint. p99 latency reduced from 450ms to 12ms.',
    toolUseId: 'tool-4',
  },
};
