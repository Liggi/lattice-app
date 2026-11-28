import { describe, expect, it } from 'vitest';
import { outputsFromEvents } from '../../src/services/sessions/conversation-outputs';
import { mergeOutputs } from '../../src/services/sessions/project-outputs-index';
import type { RawEvent } from '../../src/session-history/types';

function content(seq: number, messageId: string, text: string): RawEvent {
  return { seq, type: 'content', data: { messageId, blocks: [{ type: 'text', text }] } } as unknown as RawEvent;
}
function reported(seq: number, text: string): RawEvent {
  return { seq, type: 'worker:reported', data: { worker: 'conv-w', text } } as unknown as RawEvent;
}

describe('outputsFromEvents', () => {
  it('rejoins streamed text per message and reads images and pull requests newest first', () => {
    // Newest first, as the log is read.
    const events = [
      content(9, 'm3', 'Opened https://github.com/o/r/pull/12'),
      reported(7, 'Done: ![after](/tmp/after.png) and [PR #11 Fix thing](https://github.com/o/r/pull/11)'),
      content(5, 'm1', 'png)'),
      content(4, 'm1', '![before](/tmp/before.'),
    ];
    const outputs = outputsFromEvents(events);
    expect(outputs.images.map((image) => image.path)).toEqual(['/tmp/after.png', '/tmp/before.png']);
    expect(outputs.links.map((link) => `${link.label}:${link.title ?? ''}`)).toEqual(['#12:', '#11:Fix thing']);
  });

  it('stops at the scan limit', () => {
    const events = [content(3, 'a', 'nothing'), content(2, 'b', 'nothing'), content(1, 'c', 'https://github.com/o/r/pull/1')];
    expect(outputsFromEvents(events, 2).links).toEqual([]);
  });
});

describe('mergeOutputs', () => {
  it('puts what was just streamed first and keeps each list unique and within its limit', () => {
    const image = (path: string) => ({ path, caption: '', messageId: 'm' });
    const link = (n: number) => ({ href: `https://github.com/o/r/pull/${n}`, label: `#${n}`, kind: 'pr' as const });
    const merged = mergeOutputs(
      { images: [image('/a.png')], links: [link(9)] },
      { images: [image('/a.png'), image('/b.png'), image('/c.png'), image('/d.png'), image('/e.png')], links: [link(9), link(8)] },
    );
    expect(merged?.images.map((i) => i.path)).toEqual(['/a.png', '/b.png', '/c.png', '/d.png']);
    expect(merged?.links.map((l) => l.label)).toEqual(['#9', '#8']);
  });
});
