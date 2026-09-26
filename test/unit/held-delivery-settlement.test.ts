/**
 * What counts as the model having read a steered message: a user record in
 * Claude's transcript carrying the sent text. Its queue entry does not — that
 * is the record a message killed in the queue leaves behind.
 */

import { describe, expect, it } from 'vitest';
import { transcriptHasUserText } from '../../src/services/sessions/held-delivery-settlement.js';

const sent = '[From the server: This message arrived while this session was compacting its context; it is from Alex.]\noh one small one';

describe('settling a held delivery from the transcript', () => {
  it('does not count a queue entry the process died holding', () => {
    const lines = [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: sent }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'something else' } }),
    ];
    expect(transcriptHasUserText(lines, sent)).toBe(false);
  });

  it('counts a user message carrying the text, as a string or a text block', () => {
    expect(transcriptHasUserText([JSON.stringify({ type: 'user', message: { role: 'user', content: sent } })], sent)).toBe(true);
    expect(transcriptHasUserText([
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'image' }, { type: 'text', text: sent }] } }),
    ], sent)).toBe(true);
  });
});
