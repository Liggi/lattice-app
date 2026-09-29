import { describe, expect, it } from 'vitest';
import { externalizeEventImages, findEventImage } from '../../src/harness/event-images.js';

/**
 * Served events name their large images by URL; the URL resolves to the same
 * bytes; the stored event is never changed.
 */

const big = Buffer.alloc(20_000, 7).toString('base64');
const small = Buffer.from('tiny').toString('base64');

function screenshotResult(seq: number) {
  return {
    seq,
    type: 'result',
    data: {
      blocks: [{
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [
          { type: 'text', text: 'Took a screenshot' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: small } },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: big } },
        ],
      }],
    },
  };
}

describe('images in served events', () => {
  it('replaces a large image with a URL and keeps a small one inline', () => {
    const served = externalizeEventImages('conv-a', screenshotResult(42));
    const content = served.data.blocks[0].content as Array<{ type: string; source?: Record<string, unknown> }>;
    expect(content[0]).toEqual({ type: 'text', text: 'Took a screenshot' });
    expect(content[1].source).toEqual({ type: 'base64', media_type: 'image/png', data: small });
    expect(content[2].source).toEqual({ type: 'url', url: '/api/harness/conv-a/events/42/images/1', media_type: 'image/jpeg' });
  });

  it('resolves the URL to the original bytes and media type', () => {
    const image = findEventImage(screenshotResult(42).data, 1);
    expect(image?.mediaType).toBe('image/jpeg');
    expect(image?.bytes.equals(Buffer.from(big, 'base64'))).toBe(true);
    expect(findEventImage(screenshotResult(42).data, 2)).toBeNull();
  });

  it('leaves the stored event untouched, and returns an event without images as it is', () => {
    const stored = screenshotResult(42);
    const before = JSON.stringify(stored);
    externalizeEventImages('conv-a', stored);
    expect(JSON.stringify(stored)).toBe(before);

    const plain = { seq: 3, type: 'content', data: { blocks: [{ type: 'text', text: 'hi' }] } };
    expect(externalizeEventImages('conv-a', plain)).toBe(plain);
  });
});
