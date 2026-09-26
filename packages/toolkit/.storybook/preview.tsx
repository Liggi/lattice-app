import React from 'react';
import type { Preview, Decorator } from '@storybook/react';
import { ToolkitProvider } from '../src/context';
import '../src/styles/toolkit.css';

/** Decorator that wraps stories in ToolkitProvider with theme from toolbar. */
const withToolkit: Decorator = (Story, context) => {
  const theme = context.globals.theme || 'dark';
  return (
    <div className={theme === 'dark' ? 'dark' : ''}>
      <div className={`min-h-screen p-6 ${theme === 'dark' ? 'bg-zinc-950' : 'bg-white'}`}>
        <ToolkitProvider theme={theme}>
          <Story />
        </ToolkitProvider>
      </div>
    </div>
  );
};

const preview: Preview = {
  decorators: [withToolkit],
  globalTypes: {
    theme: {
      description: 'Light / Dark theme',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'light', title: 'Light', icon: 'sun' },
          { value: 'dark', title: 'Dark', icon: 'moon' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: 'dark',
  },
};

export default preview;
