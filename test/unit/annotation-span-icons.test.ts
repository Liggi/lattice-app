// @vitest-environment happy-dom

import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnotationSpanIcons } from '../../src/web/chat/components/MessageAnnotations/AnnotationSpanIcons.js';
import {
  ANNOTATION_ACTIVE_HIGHLIGHT_NAME,
  ANNOTATION_HIGHLIGHT_NAME,
} from '../../src/web/chat/components/MessageAnnotations/useAnnotationHighlights.js';
import type { PendingAnnotation } from '../../src/web/chat/utils/annotations-format.js';

beforeAll(() => vi.stubGlobal('React', React));
afterAll(() => vi.unstubAllGlobals());

const HOST_RECT = { top: 200, left: 50, right: 850, bottom: 600, width: 800, height: 400 };
const SPAN_END_RECT = { top: 250, left: 100, right: 400, bottom: 270, width: 300, height: 20 };

function annotation(overrides: Partial<PendingAnnotation> = {}): PendingAnnotation {
  return {
    id: 'a1',
    messageId: 'msg-assistant-1',
    quote: 'retry loop is unbounded',
    note: 'this is the bug',
    createdAt: 1,
    ...overrides,
  };
}

/** Assistant message in the real MessageList/MessageItem DOM shape. */
function mountTranscript(): void {
  const host = document.createElement('div');
  host.innerHTML = `
    <div data-message-id="msg-assistant-1">
      <div><div data-testid="assistant-message">
        <p>The retry loop is unbounded.</p>
        <p>It will spin forever on a 500.</p>
      </div></div>
    </div>
  `;
  document.body.appendChild(host);
}

/**
 * happy-dom reports every rect as zero. Layout is faked so the icon-placement
 * arithmetic (span end, relative to the message root) can be asserted.
 */
function stubLayout(): void {
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value: function getRect(this: Element) {
      return this.getAttribute('data-testid') === 'assistant-message'
        ? { ...HOST_RECT }
        : { top: 300, left: 400, right: 416, bottom: 316, width: 16, height: 16 };
    },
  });
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    writable: true,
    value: () => [{ ...SPAN_END_RECT }],
  });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value: () => ({ ...SPAN_END_RECT }),
  });
}

/** Installs a stand-in CSS Custom Highlight registry and returns it. */
function stubHighlightApi(): Map<string, { ranges: Range[] }> {
  const registry = new Map<string, { ranges: Range[] }>();
  class FakeHighlight {
    ranges: Range[];
    constructor(...ranges: Range[]) { this.ranges = ranges; }
  }
  vi.stubGlobal('Highlight', FakeHighlight);
  vi.stubGlobal('CSS', { highlights: registry });
  return registry;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  stubLayout();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('React', React);
});

/** A point inside the stubbed span rect, and one outside the message. */
const ON_SPAN = { clientX: 200, clientY: 260 };
const OFF_MESSAGE = { clientX: 5, clientY: 5 };

function renderSpans(
  annotations: PendingAnnotation[] = [annotation()],
  handlers: { onUpdate?: (id: string, note: string) => void; onRemove?: (id: string) => void } = {},
) {
  const props = {
    annotations,
    onUpdate: handlers.onUpdate ?? vi.fn(),
    onRemove: handlers.onRemove ?? vi.fn(),
  };
  return render(React.createElement(AnnotationSpanIcons, props));
}

async function pointerMove(point: { clientX: number; clientY: number }): Promise<void> {
  await act(async () => {
    const event = new MouseEvent('pointermove', { bubbles: true, ...point });
    Object.defineProperty(event, 'pointerType', { value: 'mouse' });
    document.body.dispatchEvent(event);
  });
  await flush();
}

async function clickAt(point: { clientX: number; clientY: number }): Promise<void> {
  const target = document.querySelector('[data-testid="assistant-message"] p') as HTMLElement;
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, ...point }));
  });
}

describe('AnnotationSpanIcons', () => {
  it('shows only the highlight at rest', async () => {
    const registry = stubHighlightApi();
    mountTranscript();
    renderSpans();
    await flush();

    expect(registry.get(ANNOTATION_HIGHLIGHT_NAME)?.ranges[0].toString()).toBe('retry loop is unbounded');
    expect(registry.has(ANNOTATION_ACTIVE_HIGHLIGHT_NAME)).toBe(false);
  });

  it('on hover, strengthens the span and shows a hand cursor, with no icon', async () => {
    const registry = stubHighlightApi();
    mountTranscript();
    renderSpans();
    await flush();
    await pointerMove(ON_SPAN);

    const host = document.querySelector('[data-testid="assistant-message"]') as HTMLElement;
    expect(host.style.cursor).toBe('pointer');
    expect(registry.get(ANNOTATION_ACTIVE_HIGHLIGHT_NAME)?.ranges).toHaveLength(1);
    expect(host.querySelector('button')).toBeNull();

    await pointerMove(OFF_MESSAGE);
    expect(host.style.cursor).toBe('');
    expect(registry.has(ANNOTATION_ACTIVE_HIGHLIGHT_NAME)).toBe(false);
  });

  it('clicking the span opens its note for editing, and Save updates it', async () => {
    mountTranscript();
    const onUpdate = vi.fn();
    renderSpans([annotation()], { onUpdate });
    await flush();
    await clickAt(ON_SPAN);

    const input = screen.getByTestId('annotation-note-input') as HTMLTextAreaElement;
    expect(input.value).toBe('this is the bug');
    fireEvent.change(input, { target: { value: 'actually the retry cap' } });
    fireEvent.click(screen.getByTestId('annotation-note-save'));

    expect(onUpdate).toHaveBeenCalledWith('a1', 'actually the retry cap');
    expect(screen.queryByTestId('annotation-edit-popover')).toBeNull();
  });

  it('does not open the editor when the click ends a text selection', async () => {
    mountTranscript();
    renderSpans();
    await flush();
    const text = document.querySelector('[data-testid="assistant-message"] p')?.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 9);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    await clickAt(ON_SPAN);
    expect(screen.queryByTestId('annotation-edit-popover')).toBeNull();
    window.getSelection()?.removeAllRanges();
  });

  it('ignores clicks outside any noted span', async () => {
    mountTranscript();
    renderSpans();
    await flush();
    await clickAt({ clientX: 600, clientY: 500 });

    expect(screen.queryByTestId('annotation-edit-popover')).toBeNull();
  });

  it('deletes the note from the editor', async () => {
    mountTranscript();
    const onRemove = vi.fn();
    renderSpans([annotation()], { onRemove });
    await flush();
    await clickAt(ON_SPAN);
    fireEvent.click(screen.getByTestId('annotation-note-delete'));

    expect(onRemove).toHaveBeenCalledWith('a1');
    expect(screen.queryByTestId('annotation-edit-popover')).toBeNull();
  });

  it('closes the editor on Escape without saving', async () => {
    mountTranscript();
    const onUpdate = vi.fn();
    renderSpans([annotation()], { onUpdate });
    await flush();
    await clickAt(ON_SPAN);
    expect(screen.getByTestId('annotation-edit-popover')).toBeTruthy();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(screen.queryByTestId('annotation-edit-popover')).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('marks the span under StrictMode, which mounts effects twice', async () => {
    mountTranscript();
    const registry = stubHighlightApi();
    render(React.createElement(React.StrictMode, null,
      React.createElement(AnnotationSpanIcons, { annotations: [annotation()], onUpdate: vi.fn(), onRemove: vi.fn() })));
    await flush();

    expect(registry.get(ANNOTATION_HIGHLIGHT_NAME)?.ranges[0]?.toString()).toBe('retry loop is unbounded');
  });

  it('resolves a quote that spans two markdown blocks', async () => {
    const registry = stubHighlightApi();
    mountTranscript();
    renderSpans([annotation({ quote: 'unbounded.\nIt will spin' })]);
    await flush();

    expect(registry.get(ANNOTATION_HIGHLIGHT_NAME)?.ranges).toHaveLength(1);
  });

  it('marks nothing when the quote is no longer in the message', async () => {
    const registry = stubHighlightApi();
    mountTranscript();
    renderSpans([annotation({ quote: 'text that was never rendered' })]);
    await flush();

    expect(registry.has(ANNOTATION_HIGHLIGHT_NAME)).toBe(false);
  });

  it('re-resolves when the message remounts after virtualization', async () => {
    const registry = stubHighlightApi();
    const { rerender } = renderSpans();
    await flush();
    expect(registry.has(ANNOTATION_HIGHLIGHT_NAME)).toBe(false);

    mountTranscript();
    rerender(React.createElement(AnnotationSpanIcons, { annotations: [annotation()], onUpdate: vi.fn(), onRemove: vi.fn() }));
    await flush();

    expect(registry.get(ANNOTATION_HIGHLIGHT_NAME)?.ranges).toHaveLength(1);
  });

  it('marks each annotation, including a quote that appears twice', async () => {
    const registry = stubHighlightApi();
    mountTranscript();
    renderSpans([
      annotation({ id: 'a1', quote: 'retry loop' }),
      annotation({ id: 'a2', quote: 'will spin' }),
    ]);
    await flush();

    expect(registry.get(ANNOTATION_HIGHLIGHT_NAME)?.ranges).toHaveLength(2);
  });

  it('still opens the editor when the Custom Highlight API is unavailable', async () => {
    // happy-dom has no CSS.highlights.
    mountTranscript();
    renderSpans();
    await flush();
    await clickAt(ON_SPAN);

    expect(screen.getByTestId('annotation-edit-popover')).toBeTruthy();
  });

  it('clears the highlight registry when the last annotation goes and on unmount', async () => {
    const registry = stubHighlightApi();
    mountTranscript();
    const { rerender, unmount } = renderSpans();
    await flush();
    expect(registry.has(ANNOTATION_HIGHLIGHT_NAME)).toBe(true);

    rerender(React.createElement(AnnotationSpanIcons, { annotations: [], onUpdate: vi.fn(), onRemove: vi.fn() }));
    await flush();
    expect(registry.has(ANNOTATION_HIGHLIGHT_NAME)).toBe(false);

    rerender(React.createElement(AnnotationSpanIcons, { annotations: [annotation()], onUpdate: vi.fn(), onRemove: vi.fn() }));
    await flush();
    unmount();
    expect(registry.has(ANNOTATION_HIGHLIGHT_NAME)).toBe(false);
  });
});
