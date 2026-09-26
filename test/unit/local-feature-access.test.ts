// @vitest-environment happy-dom

import * as React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UnifiedConversationSummary } from '../../src/web/chat/types/index.js';

vi.mock('../../src/web/chat/hooks/useAttentionFavicon', () => ({
  useSessionAttention: () => false,
}));

vi.mock('../../src/web/chat/contexts/ConversationsContext', () => ({
  useConversations: () => ({ conversations: [] }),
}));

import { SessionCard } from '../../src/web/chat/components/shared/SessionCard.js';
import { TooltipProvider } from '../../src/web/chat/components/ui/tooltip.js';

beforeAll(() => vi.stubGlobal('React', React));
afterAll(() => vi.unstubAllGlobals());

function conversation(): UnifiedConversationSummary {
  return {
    conversationId: 'conv-local-features',
    createdAt: '2026-07-22T12:00:00.000Z',
    updatedAt: '2026-07-22T12:30:00.000Z',
    workingDirectory: '/tmp/lattice',
    latestProvider: 'codex',
    segmentCount: 1,
    status: 'idle',
    streamingId: null,
    customName: '',
    pinned: true,
    archived: false,
    pausedReason: null,
    importedAt: null,
    permissionMode: null,
    identityImage: 'persisted-session-art',
    pinCharacterName: 'Rune',
    pinCharacterImage: 'persisted-character-art',
    initialPrompt: 'Raw initial prompt',
    insights: {
      sessionId: 'conv-local-features',
      context: {
        project: 'Lattice',
        area: 'sidebar',
        mission: 'Persisted mission from local insights',
        scope: 'feature',
      },
      theme: 'building',
      tags: { complexity: 'tricky' },
    },
  };
}

describe('local feature access', () => {
  it('renders persisted sidebar art and insights without putting the character in the sidebar', () => {
    const { container } = render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(SessionCard, { conversation: conversation() })
      )
    );

    expect(screen.getByTestId('session-image-conv-local-features')).toBeTruthy();
    expect(screen.getByText('Persisted mission from local insights')).toBeTruthy();
    expect(container.querySelector('img[alt="Rune"]')).toBeNull();
  });

  it('keeps hosted-license checks out of local feature paths', () => {
    const localFeatureFiles = [
      'src/routes/insights/insights.routes.ts',
      'src/routes/conversation/unified-conversation.control-routes.ts',
      'src/routes/session/permission.routes.ts',
      'src/services/insights/insights-engine.ts',
      'src/services/sessions/turn-capture-service.ts',
      'src/web/chat/components/shared/SessionCard.tsx',
      'src/web/chat/components/ConversationHeader/ConversationHeader.tsx',
      'src/web/chat/components/ConversationView/ConversationView.tsx',
      'src/web/chat/components/CrossSessionSidebar/CrossSessionSidebar.tsx',
    ];

    for (const relativePath of localFeatureFiles) {
      const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
      expect(source, relativePath).not.toMatch(/LicenseService|useLicense|canUseHostedAi/);
    }

    expect(
      fs.existsSync(path.join(process.cwd(), 'src/web/chat/contexts/LicenseContext.tsx'))
    ).toBe(false);
  });
});
