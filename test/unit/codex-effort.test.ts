/**
 * What a Codex conversation runs at: an explicit request first, then the
 * setting it is actually on, then evidence of an older explicit choice, and a
 * default only when nothing else is known.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';
import { enqueueInboxItem, markInboxItemsRead } from '../../src/services/sessions/session-inbox.js';
import {
  currentCodexReasoningEffort,
  inferredCodexReasoningEffort,
  resolveCodexReasoningEffort,
} from '../../src/services/sessions/codex-effort.js';

beforeEach(async () => {
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
  await new SessionInfoService(':memory:').initialize();
  ConversationService.getInstance().initialize(DatabaseProvider.getInstance().getDb());
});
afterEach(() => {
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
});

function codexConversation(reasoningEffort?: string): string {
  return ConversationService.getInstance().createConversation({
    workingDirectory: '/tmp/project',
    provider: 'codex',
    providerSessionId: `pending-${Date.now()}`,
    model: 'gpt-6-astra',
    reasoningEffort,
  }).conversationId;
}

describe('resolveCodexReasoningEffort', () => {
  it('prefers an explicit request over everything already known', () => {
    expect(resolveCodexReasoningEffort({
      requested: 'low', stored: 'medium', inferred: 'high', fallback: 'max',
    })).toEqual({ effort: 'low', source: 'request' });
  });

  it('falls to the applied setting, then to inferred evidence, then to the fallback', () => {
    expect(resolveCodexReasoningEffort({ stored: 'medium', inferred: 'high' }))
      .toEqual({ effort: 'medium', source: 'segment' });
    expect(resolveCodexReasoningEffort({ inferred: 'high' }))
      .toEqual({ effort: 'high', source: 'history' });
    expect(resolveCodexReasoningEffort({ fallback: 'medium' }))
      .toEqual({ effort: 'medium', source: 'default' });
    expect(resolveCodexReasoningEffort({}))
      .toEqual({ effort: 'xhigh', source: 'default' });
  });

  it('ignores blank values rather than treating them as a choice', () => {
    expect(resolveCodexReasoningEffort({ requested: '  ', stored: 'low' }))
      .toEqual({ effort: 'low', source: 'segment' });
  });
});

describe('the conversation\'s current setting', () => {
  it('is what the segment records, for a request that names none', () => {
    const conversationId = codexConversation('medium');
    expect(currentCodexReasoningEffort(conversationId))
      .toEqual({ effort: 'medium', source: 'segment' });
  });

  it('is the request when one is named, and the segment is left to the applied callback', () => {
    const conversationId = codexConversation('medium');
    expect(currentCodexReasoningEffort(conversationId, 'low'))
      .toEqual({ effort: 'low', source: 'request' });
    expect(ConversationService.getInstance().getLatestSegment(conversationId)?.reasoningEffort)
      .toBe('medium');
  });

  it('is null for a conversation that is not on Codex', () => {
    const { conversationId } = ConversationService.getInstance().createConversation({
      workingDirectory: '/tmp/project',
      provider: 'claude',
      providerSessionId: 'pending-claude',
    });
    expect(currentCodexReasoningEffort(conversationId)).toBeNull();
  });
});

/** An inbox message a turn has taken, which is what makes it evidence. */
function delivered(conversationId: string, text: string, reasoningEffort?: string): void {
  const id = enqueueInboxItem({ sessionId: conversationId, source: 'user', text, reasoningEffort });
  markInboxItemsRead([id]);
}

describe('legacy evidence', () => {
  it('is the last effort the conversation was actually given, when nothing was recorded', () => {
    const conversationId = codexConversation();
    delivered(conversationId, 'one', 'xhigh');
    delivered(conversationId, 'two', 'medium');
    delivered(conversationId, 'three');

    expect(inferredCodexReasoningEffort(conversationId)).toBe('medium');
    expect(currentCodexReasoningEffort(conversationId))
      .toEqual({ effort: 'medium', source: 'history' });
  });

  it('ignores a message still waiting to be read', () => {
    const conversationId = codexConversation();
    delivered(conversationId, 'delivered', 'medium');
    enqueueInboxItem({ sessionId: conversationId, source: 'user', text: 'parked', reasoningEffort: 'low' });

    expect(inferredCodexReasoningEffort(conversationId)).toBe('medium');
  });

  it('never displaces a recorded setting', () => {
    const conversationId = codexConversation('low');
    delivered(conversationId, 'old', 'xhigh');

    expect(currentCodexReasoningEffort(conversationId))
      .toEqual({ effort: 'low', source: 'segment' });
  });

  it('leaves a conversation with no evidence at the default, rather than inventing a choice', () => {
    const conversationId = codexConversation();
    expect(inferredCodexReasoningEffort(conversationId)).toBeNull();
    expect(currentCodexReasoningEffort(conversationId))
      .toEqual({ effort: 'xhigh', source: 'default' });
  });
});
