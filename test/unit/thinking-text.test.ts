/**
 * Thinking summaries keep the line breaks the model wrote: Codex sends its
 * headers one per line, and markdown would otherwise run them together.
 */

import { describe, expect, it } from 'vitest';
import { preserveThinkingBreaks } from '../../src/web/chat/utils/thinking-text.js';

describe('preserveThinkingBreaks', () => {
  it('breaks Codex header lines apart and leaves blank-line prose alone', () => {
    expect(preserveThinkingBreaks('**Reading saved thread state**\n**Setting Astra to medium**'))
      .toBe('**Reading saved thread state**  \n**Setting Astra to medium**');
    const prose = 'I checked the fold.\n\nIt was historical.';
    expect(preserveThinkingBreaks(prose)).toBe(prose);
  });

  it('leaves fenced code as written', () => {
    const fenced = 'Before:\n```ts\nconst a = 1;\nconst b = 2;\n```\nAfter';
    expect(preserveThinkingBreaks(fenced)).toBe('Before:  \n```ts\nconst a = 1;\nconst b = 2;\n```\nAfter');
  });
});
