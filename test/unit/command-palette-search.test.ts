import { describe, expect, it } from 'vitest';
import { conversationItem, folderName, scoreItem, searchPalette, type PaletteItem } from '../../src/web/chat/components/CommandPalette/command-palette-search';
import type { UnifiedConversationSummary } from '../../src/web/chat/types';

function conv(id: string, overrides: Partial<UnifiedConversationSummary> = {}): UnifiedConversationSummary {
  return {
    conversationId: id,
    createdAt: '2026-11-20T10:00:00Z',
    updatedAt: '2026-11-20T10:00:00Z',
    workingDirectory: '/Users/someone/src/payments-service',
    ...overrides,
  } as UnifiedConversationSummary;
}

const action = (title: string): PaletteItem => ({ id: `action:${title}`, group: 'Actions', kind: 'action', title, target: { type: 'settings' } });

describe('command palette search', () => {
  it('names a conversation by its custom name, then mission, then first prompt', () => {
    expect(conversationItem(conv('conv-a', { customName: 'Payments retry worker migration' })).title).toBe('Payments retry worker migration');
    expect(conversationItem(conv('conv-b', { initialPromptPreview: 'fix the flaky test' })).title).toBe('fix the flaky test');
    expect(conversationItem(conv('conv-c')).title).toBe('conv-c');
  });

  it('groups projects, sessions and archived work, with the folder as the subtitle', () => {
    expect(conversationItem(conv('conv-a', { coordinator: true })).group).toBe('Projects');
    expect(conversationItem(conv('conv-a')).group).toBe('Sessions');
    const archived = conversationItem(conv('conv-a'), true);
    expect(archived.group).toBe('Archived');
    expect(archived.subtitle).toBe('Archived');
    expect(conversationItem(conv('conv-a')).subtitle).toBe('payments-service');
    expect(folderName('/a/b/c/')).toBe('c');
  });

  it('ranks a title that starts with the query over a word inside one, over a folder match, over loose letters', () => {
    const start = action('Retry worker');
    const word = action('Payments retry');
    const inside = action('Autoretry');
    const folder: PaletteItem = { ...action('Docs search'), subtitle: 'retry-service' };
    const loose = action('Reading the try');
    const scores = [start, word, inside, folder, loose].map((item) => scoreItem(item, 'retry'));
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(scores.every((score) => score > 0)).toBe(true);
    expect(scoreItem(action('Settings'), 'retry')).toBe(0);
  });

  it('is case-insensitive and needs every word of the query', () => {
    expect(scoreItem(action('Payments Retry Worker'), 'PAYMENTS worker')).toBeGreaterThan(0);
    expect(scoreItem(action('Payments Retry Worker'), 'payments billing')).toBe(0);
  });

  it('with nothing typed shows the five most recently used, then actions, and no archived work', () => {
    const items: PaletteItem[] = [
      ...Array.from({ length: 7 }, (_, index) => conversationItem(conv(`conv-${index}`, {
        customName: `Session ${index}`,
        lastActivityAt: new Date(Date.UTC(2026, 10, 20, index)).toISOString(),
      }))),
      conversationItem(conv('conv-old', { customName: 'Old work' }), true),
      action('Settings'),
    ];
    const results = searchPalette(items, '');
    expect(results.filter((item) => item.group === 'Recent').map((item) => item.title)).toEqual(['Session 6', 'Session 5', 'Session 4', 'Session 3', 'Session 2']);
    expect(results.at(-1)?.title).toBe('Settings');
    expect(results.some((item) => item.group === 'Archived')).toBe(false);
  });

  it('searches archived sessions once the reader types, after live ones', () => {
    const items = [
      conversationItem(conv('conv-old', { customName: 'Rate limiter rollout' }), true),
      conversationItem(conv('conv-live', { customName: 'Rate limiter follow-up', coordinator: true })),
    ];
    expect(searchPalette(items, 'rate limiter').map((item) => item.group)).toEqual(['Projects', 'Archived']);
  });

  it('keeps every archived match up to twenty', () => {
    const items = Array.from({ length: 30 }, (_, index) => conversationItem(conv(`conv-${index}`, { customName: `Archived thing ${index}` }), true));
    expect(searchPalette(items, 'archived')).toHaveLength(20);
  });
});
