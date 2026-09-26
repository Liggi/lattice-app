import type { Meta, StoryObj } from '@storybook/react';
import { Composer } from '../components/Composer';

const meta: Meta<typeof Composer> = {
  title: 'Composer/Composer',
  component: Composer,
  parameters: {
    layout: 'padded',
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 800 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof Composer>;

/** Default idle state — no session connected. */
export const Off: Story = {
  args: {
    core: {
      onSubmit: (message) => console.log('Submit:', message),
      placeholder: 'Type a message...',
    },
    features: {
      showStatusBar: true,
      enableAttachments: true,
    },
  },
};

/** Session connected and idle — ready for input. */
export const Ready: Story = {
  args: {
    core: {
      onSubmit: (message) => console.log('Submit:', message),
      placeholder: 'Send a follow-up...',
    },
    features: {
      showStatusBar: true,
      enableAttachments: true,
    },
    runtimeConfig: {
      isSessionConnected: true,
    },
  },
};

/** Session actively streaming a response. */
export const Active: Story = {
  args: {
    core: {
      onSubmit: (message) => console.log('Submit:', message),
      placeholder: 'Send a follow-up...',
    },
    features: {
      showStatusBar: true,
      enableAttachments: true,
    },
    runtimeConfig: {
      isSessionActive: true,
      isSessionConnected: true,
      sessionStartTime: Date.now() - 42_000,
    },
    permissionConfig: {
      onStop: () => console.log('Stop'),
      onInterrupt: () => console.log('Interrupt'),
    },
  },
};

/** Session is initializing (starting up). */
export const Starting: Story = {
  args: {
    core: {
      onSubmit: (message) => console.log('Submit:', message),
      disabled: true,
    },
    features: {
      showStatusBar: true,
    },
    runtimeConfig: {
      isInitializing: true,
    },
  },
};

/** Stop has been requested — waiting for graceful shutdown. */
export const Stopping: Story = {
  args: {
    core: {
      onSubmit: (message) => console.log('Submit:', message),
    },
    features: {
      showStatusBar: true,
    },
    runtimeConfig: {
      isSessionActive: true,
      isSessionConnected: true,
      isStopRequested: true,
    },
  },
};

/** Active session with token usage displayed. */
export const WithUsage: Story = {
  args: {
    core: {
      onSubmit: (message) => console.log('Submit:', message),
    },
    features: {
      showStatusBar: true,
      enableAttachments: true,
    },
    runtimeConfig: {
      isSessionConnected: true,
      isSessionActive: true,
      sessionStartTime: Date.now() - 18_000,
      sessionUsage: {
        inputTokens: 142_500,
        outputTokens: 8_730,
        cacheCreationInputTokens: 45_000,
        cacheReadInputTokens: 97_500,
      },
    },
    permissionConfig: {
      onStop: () => console.log('Stop'),
    },
  },
};

/** Ready state with a background task still running. */
export const BackgroundTask: Story = {
  args: {
    core: {
      onSubmit: (message) => console.log('Submit:', message),
    },
    features: {
      showStatusBar: true,
    },
    runtimeConfig: {
      isSessionConnected: true,
      hasBackgroundTasks: true,
    },
  },
};

/** The same waiting state, named by a host that knows what kind of work it is. */
export const BackgroundTaskCustomLabel: Story = {
  args: {
    core: {
      onSubmit: (message) => console.log('Submit:', message),
    },
    features: {
      showStatusBar: true,
    },
    runtimeConfig: {
      isSessionConnected: true,
      hasBackgroundTasks: true,
      backgroundTaskLabel: 'Waiting for subagent',
    },
  },
};

/** Messages queued while the session was busy. */
export const QueuedMessages: Story = {
  args: {
    core: {
      onSubmit: (message) => console.log('Submit:', message),
    },
    features: {
      showStatusBar: true,
    },
    runtimeConfig: {
      isSessionConnected: true,
      isSessionActive: true,
      sessionStartTime: Date.now() - 65_000,
      queuedMessages: [
        { id: 'q1', content: 'also fix the tests', timestamp: new Date(Date.now() - 30_000).toISOString(), status: 'pending' as const },
        { id: 'q2', content: 'and update the README', timestamp: new Date(Date.now() - 10_000).toISOString(), status: 'pending' as const },
      ],
    },
    permissionConfig: {
      onStop: () => console.log('Stop'),
    },
  },
};

/** No status bar — minimal variant. */
export const Minimal: Story = {
  args: {
    core: {
      onSubmit: (message) => console.log('Submit:', message),
      placeholder: 'Ask anything...',
    },
    features: {
      showStatusBar: false,
      enableAttachments: false,
    },
  },
};

/** With a render menu slot (simulates SmartMenu integration). */
export const WithMenu: Story = {
  args: {
    core: {
      onSubmit: (message) => console.log('Submit:', message),
    },
    features: {
      showStatusBar: true,
      showMenu: true,
    },
    runtimeConfig: {
      isSessionConnected: true,
    },
    renderMenu: ({ onClose }) => (
      <div
        style={{
          padding: '12px 16px',
          background: 'var(--color-composer-surface-elevated)',
          border: '1px solid var(--color-composer-border)',
          borderRadius: 6,
          fontSize: 13,
          color: 'var(--color-composer-text-secondary)',
        }}
      >
        Custom menu content —{' '}
        <button onClick={onClose} style={{ textDecoration: 'underline', cursor: 'pointer', background: 'none', border: 'none', color: 'inherit' }}>
          close
        </button>
      </div>
    ),
  },
};
