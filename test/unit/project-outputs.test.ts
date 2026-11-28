import { describe, expect, it } from 'vitest';
import { outputCaptionLabels } from '../../src/web/chat/components/InsightsPanel/project-outputs';

describe('outputCaptionLabels', () => {
  it('uses the lead phrase before an em-dash, colon, or sentence break', () => {
    expect(outputCaptionLabels([
      { caption: 'Desktop workspace — quieter sidebar, Track & Outputs right panel' },
      { caption: 'Working Cmd+K: live fuzzy search across projects and sessions' },
      { caption: 'Phone chat. Clean table at 390px without clipping' },
      { caption: 'After the fix' },
    ])).toEqual([
      'Desktop workspace',
      'Working Cmd+K',
      'Phone chat',
      'After the fix',
    ]);
  });

  it('keeps full captions when shortening would make two tiles share a label', () => {
    expect(outputCaptionLabels([
      { caption: 'Linear: work grouped by status glyph' },
      { caption: 'Linear: PR stack drawn as a vertical chain' },
      { caption: 'Vercel ⌘K — single-line icon + label rows' },
    ])).toEqual([
      'Linear: work grouped by status glyph',
      'Linear: PR stack drawn as a vertical chain',
      'Vercel ⌘K',
    ]);
  });

  it('ignores tiny or numeric prefixes and handles empty captions', () => {
    expect(outputCaptionLabels([
      { caption: '1: Desktop view' },
      { caption: 'v2: Updated layout' },
      { caption: '' },
    ])).toEqual([
      '1: Desktop view',
      'v2: Updated layout',
      '',
    ]);
  });
});
