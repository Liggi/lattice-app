// @vitest-environment happy-dom

import * as React from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnotationSelectionLayer } from '../../src/web/chat/components/MessageAnnotations/AnnotationSelectionLayer.js';
import { AnnotationStatusBadge } from '../../src/web/chat/components/MessageAnnotations/AnnotationStatusBadge.js';
import { SELECTION_HIDE_DELAY_MS } from '../../src/web/chat/components/MessageAnnotations/AnnotationSelectionLayer.js';
import { useMessageAnnotations } from '../../src/web/chat/hooks/useMessageAnnotations.js';
import { annotationsStorageKey } from '../../src/web/chat/utils/annotations-format.js';

beforeAll(() => vi.stubGlobal('React', React));
afterAll(() => vi.unstubAllGlobals());

const LONG_QUOTE = `The retry loop never backs off. ${'It reissues the same request immediately. '.repeat(40)}`.trim();

/** Transcript scaffolding matching the real MessageList/MessageItem DOM shape. */
function mountTranscript(): Node {
  const host = document.createElement('div');
  host.innerHTML = `
    <div data-message-id="msg-assistant-1">
      <div><div data-testid="assistant-message"><p id="assistant-text"></p></div></div>
    </div>
  `;
  document.body.appendChild(host);
  const paragraph = host.querySelector('#assistant-text');
  if (!paragraph) throw new Error('scaffold missing');
  paragraph.textContent = LONG_QUOTE;
  const textNode = paragraph.firstChild;
  if (!textNode) throw new Error('scaffold text node missing');
  return textNode;
}

/** Installs a fake window.getSelection returning the given selected text. */
function stubSelection(
  anchorNode: Node | null,
  text: string,
  isCollapsed = false,
  rect = () => ({ top: 200, bottom: 220, left: 100, right: 300, width: 200, height: 20 }),
): void {
  const selection = {
    isCollapsed,
    rangeCount: anchorNode ? 1 : 0,
    anchorNode,
    focusNode: anchorNode,
    toString: () => text,
    getRangeAt: () => ({
      getBoundingClientRect: rect,
    }),
    removeAllRanges: () => {},
  };
  vi.stubGlobal('getSelection', () => selection);
  window.getSelection = (() => selection) as typeof window.getSelection;
}

/** Forces `(pointer: coarse)` to a known value. */
function stubPointer(coarse: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes('coarse') ? coarse : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

interface FakeVisualViewport {
  set: (next: { offsetTop: number; height: number; width?: number }) => void;
}

/**
 * Installs a controllable visualViewport plus a fixed layout-viewport height,
 * so keyboard behaviour can be simulated.
 */
function stubViewport(layoutHeight: number, initial: { offsetTop: number; height: number; width?: number }): FakeVisualViewport {
  const listeners = new Set<() => void>();
  const state = { offsetTop: initial.offsetTop, height: initial.height, width: initial.width ?? 390 };
  const fake = {
    get offsetTop() { return state.offsetTop; },
    get height() { return state.height; },
    get width() { return state.width; },
    addEventListener: (_type: string, handler: () => void) => { listeners.add(handler); },
    removeEventListener: (_type: string, handler: () => void) => { listeners.delete(handler); },
  };
  Object.defineProperty(window, 'visualViewport', { configurable: true, writable: true, value: fake });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: layoutHeight });
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: state.width });
  return {
    set: (next) => {
      state.offsetTop = next.offsetTop;
      state.height = next.height;
      if (next.width !== undefined) state.width = next.width;
      listeners.forEach((handler) => handler());
    },
  };
}

/** Lets the layer's rAF-coalesced selection watcher run. */
async function settle(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  stubPointer(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('React', React);
});

describe('AnnotationSelectionLayer — desktop (selection-anchored)', () => {
  it('offers "Add note" once a selection lands inside an assistant message', async () => {
    const textNode = mountTranscript();
    stubSelection(textNode, 'The retry loop never backs off.');

    render(React.createElement(AnnotationSelectionLayer, { onAdd: vi.fn() }));
    expect(screen.queryByTestId('annotation-add-button')).toBeNull();

    await settle();
    const button = screen.getByTestId('annotation-add-button');
    // Icon only: named for screen readers, with no browser tooltip.
    expect(button.getAttribute('aria-label')).toBe('Add note');
    expect(button.hasAttribute('title')).toBe(false);
    expect(button.textContent).toBe('');
  });

  it('portals the anchored pill to <body>, escaping the composer dock backdrop-filter', async () => {
    const textNode = mountTranscript();
    stubSelection(textNode, 'The retry loop never backs off.');

    const { container } = render(React.createElement(AnnotationSelectionLayer, { onAdd: vi.fn() }));
    await settle();

    const pill = screen.getByTestId('annotation-add-button');
    expect(container.contains(pill)).toBe(false);
    expect(pill.parentElement).toBe(document.body);
  });

  it('follows the selection when the transcript scrolls, and hides once it scrolls out of view', async () => {
    const textNode = mountTranscript();
    let top = 300;
    stubSelection(textNode, 'The retry loop never backs off.', false,
      () => ({ top, bottom: top + 20, left: 100, right: 300, width: 200, height: 20 }));
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 800 });

    render(React.createElement(AnnotationSelectionLayer, { onAdd: vi.fn() }));
    await settle();
    const pill = screen.getByTestId('annotation-add-button');
    expect(pill.style.top).toBe(`${300 - 28 - 8}px`);

    const scroll = async () => act(async () => {
      document.getElementById('assistant-text')?.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    top = 500;
    await scroll();
    expect(screen.getByTestId('annotation-add-button').style.top).toBe(`${500 - 28 - 8}px`);

    top = 900;
    await scroll();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, SELECTION_HIDE_DELAY_MS + 20)); });
    expect(screen.queryByTestId('annotation-add-button')).toBeNull();
  });

  it('stays hidden when the selection is outside an assistant message', async () => {
    mountTranscript();
    const stray = document.createElement('p');
    stray.textContent = 'page chrome';
    document.body.appendChild(stray);
    stubSelection(stray.firstChild, 'page chrome');

    render(React.createElement(AnnotationSelectionLayer, { onAdd: vi.fn() }));
    await settle();

    expect(screen.queryByTestId('annotation-add-button')).toBeNull();
  });

  it('opens the anchored popover rather than a bottom sheet', async () => {
    const textNode = mountTranscript();
    stubSelection(textNode, 'The retry loop never backs off.');

    render(React.createElement(AnnotationSelectionLayer, { onAdd: vi.fn() }));
    await settle();
    fireEvent.click(screen.getByTestId('annotation-add-button'));

    expect(screen.getByTestId('annotation-note-popover')).toBeTruthy();
    expect(screen.queryByTestId('annotation-note-sheet')).toBeNull();
  });

  it('captures the full quote and message id when the note is submitted with Enter', async () => {
    const textNode = mountTranscript();
    stubSelection(textNode, LONG_QUOTE);
    const onAdd = vi.fn();

    render(React.createElement(AnnotationSelectionLayer, { onAdd }));
    await settle();
    fireEvent.click(screen.getByTestId('annotation-add-button'));

    // The affordance is replaced by the note input, and the captured span is
    // now frozen — collapsing the document selection must not lose it.
    const input = screen.getByTestId('annotation-note-input') as HTMLTextAreaElement;
    stubSelection(null, '', true);
    await settle();

    fireEvent.change(input, { target: { value: 'this is the bug' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith({
      messageId: 'msg-assistant-1',
      quote: LONG_QUOTE,
      note: 'this is the bug',
      quoteStart: null,
    });
  });

  it('cancels on Escape without creating an annotation', async () => {
    const textNode = mountTranscript();
    stubSelection(textNode, 'The retry loop never backs off.');
    const onAdd = vi.fn();

    render(React.createElement(AnnotationSelectionLayer, { onAdd }));
    await settle();
    fireEvent.click(screen.getByTestId('annotation-add-button'));
    fireEvent.change(screen.getByTestId('annotation-note-input'), { target: { value: 'half typed' } });

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.queryByTestId('annotation-note-popover')).toBeNull();
  });

  it('refuses to save an empty note', async () => {
    const textNode = mountTranscript();
    stubSelection(textNode, 'The retry loop never backs off.');
    const onAdd = vi.fn();

    render(React.createElement(AnnotationSelectionLayer, { onAdd }));
    await settle();
    fireEvent.click(screen.getByTestId('annotation-add-button'));
    fireEvent.change(screen.getByTestId('annotation-note-input'), { target: { value: '   ' } });
    fireEvent.keyDown(screen.getByTestId('annotation-note-input'), { key: 'Enter' });

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByTestId('annotation-note-popover')).toBeTruthy();
  });
});

describe('AnnotationSelectionLayer — touch (docked)', () => {
  beforeEach(() => {
    stubPointer(true);
    stubViewport(800, { offsetTop: 0, height: 800, width: 390 });
  });

  it('floats the pill above the composer dock, portalled and out of the layout', async () => {
    const textNode = mountTranscript();
    stubSelection(textNode, 'The retry loop never backs off.');

    const { container } = render(React.createElement(AnnotationSelectionLayer, { onAdd: vi.fn() }));
    await settle();

    // The pill sits in a bar that also carries the message's other touch
    // actions (React, Copy all). Portalled and fixed: mounting it must not
    // shift the composer area, and it must not be selection-anchored (that
    // collides with the iOS edit menu).
    const bar = screen.getByTestId('annotation-docked-bar');
    expect(bar.contains(screen.getByTestId('annotation-add-button'))).toBe(true);
    expect(container.contains(bar)).toBe(false);
    expect(bar.parentElement).toBe(document.body);
    expect(bar.className).toContain('fixed');
    expect(bar.style.bottom).not.toBe('');
    expect(bar.style.top).toBe('');
  });

  it('puts the message\'s other actions beside the pill', async () => {
    const textNode = mountTranscript();
    stubSelection(textNode, 'The retry loop never backs off.');

    render(React.createElement(AnnotationSelectionLayer, {
      onAdd: vi.fn(),
      renderDockedActions: (messageId: string) => React.createElement('button', { 'data-testid': 'extra' }, messageId),
    }));
    await settle();

    expect(screen.getByTestId('annotation-docked-bar').contains(screen.getByTestId('extra'))).toBe(true);
    expect(screen.getByTestId('extra').textContent).toBe('msg-assistant-1');
  });

  it('sits above the measured composer dock', async () => {
    const dock = document.createElement('div');
    dock.setAttribute('data-composer-dock', 'true');
    Object.defineProperty(dock, 'getBoundingClientRect', {
      value: () => ({ top: 700, bottom: 800, left: 0, right: 390, width: 390, height: 100 }),
    });
    document.body.appendChild(dock);

    const textNode = mountTranscript();
    stubSelection(textNode, 'The retry loop never backs off.');

    render(React.createElement(AnnotationSelectionLayer, { onAdd: vi.fn() }));
    await settle();

    // 800 layout - 700 dock top = 100 of dock below, + 8 gap.
    expect(screen.getByTestId('annotation-docked-bar').style.bottom).toBe('108px');
  });

  it('opens the note editor as a bottom sheet, not an anchored popover', async () => {
    const textNode = mountTranscript();
    stubSelection(textNode, 'The retry loop never backs off.');

    render(React.createElement(AnnotationSelectionLayer, { onAdd: vi.fn() }));
    await settle();
    fireEvent.click(screen.getByTestId('annotation-add-button'));

    expect(screen.getByTestId('annotation-note-sheet')).toBeTruthy();
    expect(screen.queryByTestId('annotation-note-popover')).toBeNull();
  });

  it('sits flush at the bottom while no keyboard is open', async () => {
    const textNode = mountTranscript();
    stubSelection(textNode, 'a span');

    render(React.createElement(AnnotationSelectionLayer, { onAdd: vi.fn() }));
    await settle();
    fireEvent.click(screen.getByTestId('annotation-add-button'));

    expect(screen.getByTestId('annotation-note-sheet').style.bottom).toBe('12px');
  });

  it('rides above the keyboard when the visual viewport shrinks', async () => {
    const textNode = mountTranscript();
    stubSelection(textNode, 'a span');
    const viewport = stubViewport(800, { offsetTop: 0, height: 800, width: 390 });

    render(React.createElement(AnnotationSelectionLayer, { onAdd: vi.fn() }));
    await settle();
    fireEvent.click(screen.getByTestId('annotation-add-button'));

    await act(async () => {
      viewport.set({ offsetTop: 0, height: 500 });
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });

    // 800 layout - 0 offset - 500 visual = 300 keyboard, + 12 margin.
    expect(screen.getByTestId('annotation-note-sheet').style.bottom).toBe('312px');
  });

  it('compensates when iOS also pans the visual viewport to reveal the input', async () => {
    const textNode = mountTranscript();
    stubSelection(textNode, 'a span');
    const viewport = stubViewport(800, { offsetTop: 0, height: 800, width: 390 });

    render(React.createElement(AnnotationSelectionLayer, { onAdd: vi.fn() }));
    await settle();
    fireEvent.click(screen.getByTestId('annotation-add-button'));

    await act(async () => {
      viewport.set({ offsetTop: 120, height: 500 });
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });

    // Visible bottom edge is at layout-y 620, so bottom is 180 (+12), not 300.
    expect(screen.getByTestId('annotation-note-sheet').style.bottom).toBe('192px');
  });

  it('opens on touchend, before the tap clears the selection and unmounts the pill', async () => {
    const textNode = mountTranscript();
    stubSelection(textNode, 'a span');

    render(React.createElement(AnnotationSelectionLayer, { onAdd: vi.fn() }));
    await settle();

    // Tap, then let the selection collapse exactly as iOS does — the click
    // event would arrive after the watcher had already dropped the target.
    fireEvent.touchEnd(screen.getByTestId('annotation-add-button'));
    stubSelection(null, '', true);
    await settle();

    expect(screen.getByTestId('annotation-note-sheet')).toBeTruthy();
  });

  it('does not double-fire from the ghost click after a touch', async () => {
    const textNode = mountTranscript();
    stubSelection(textNode, 'a span');

    render(React.createElement(AnnotationSelectionLayer, { onAdd: vi.fn() }));
    await settle();

    const pill = screen.getByTestId('annotation-add-button');
    fireEvent.touchEnd(pill);
    fireEvent.click(pill);

    expect(screen.getAllByTestId('annotation-note-sheet')).toHaveLength(1);
  });

  it('saves the note from the sheet', async () => {
    const textNode = mountTranscript();
    stubSelection(textNode, LONG_QUOTE);
    const onAdd = vi.fn();

    render(React.createElement(AnnotationSelectionLayer, { onAdd }));
    await settle();
    fireEvent.click(screen.getByTestId('annotation-add-button'));
    fireEvent.change(screen.getByTestId('annotation-note-input'), { target: { value: 'from my phone' } });
    fireEvent.click(screen.getByTestId('annotation-note-save'));

    expect(onAdd).toHaveBeenCalledWith({
      messageId: 'msg-assistant-1',
      quote: LONG_QUOTE,
      note: 'from my phone',
      quoteStart: null,
    });
  });
});

describe('AnnotationSelectionLayer — anti-flicker debounce', () => {
  beforeEach(() => {
    stubPointer(true);
    stubViewport(800, { offsetTop: 0, height: 800, width: 390 });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Flushes the watcher's rAF under fake timers. */
  async function tick(ms = 20): Promise<void> {
    await act(async () => {
      document.dispatchEvent(new Event('selectionchange'));
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  async function advance(ms: number): Promise<void> {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  it('appears immediately on a valid selection', async () => {
    const textNode = mountTranscript();
    stubSelection(textNode, 'a span');

    render(React.createElement(AnnotationSelectionLayer, { onAdd: vi.fn() }));
    await tick();

    expect(screen.getByTestId('annotation-add-button')).toBeTruthy();
  });

  it('does not hide the instant the selection collapses', async () => {
    const textNode = mountTranscript();
    stubSelection(textNode, 'a span');
    render(React.createElement(AnnotationSelectionLayer, { onAdd: vi.fn() }));
    await tick();

    // A momentary collapse, as happens while dragging the iOS selection
    // handles across a word boundary.
    stubSelection(null, '', true);
    await tick();

    expect(screen.getByTestId('annotation-add-button')).toBeTruthy();
  });

  it('hides once the selection has stayed gone past the debounce', async () => {
    const textNode = mountTranscript();
    stubSelection(textNode, 'a span');
    render(React.createElement(AnnotationSelectionLayer, { onAdd: vi.fn() }));
    await tick();

    stubSelection(null, '', true);
    await tick();
    await advance(SELECTION_HIDE_DELAY_MS + 20);

    expect(screen.queryByTestId('annotation-add-button')).toBeNull();
  });

  it('cancels the pending hide when a valid selection comes back', async () => {
    const textNode = mountTranscript();
    stubSelection(textNode, 'a span');
    render(React.createElement(AnnotationSelectionLayer, { onAdd: vi.fn() }));
    await tick();

    // Collapse, wait less than the debounce, then reselect — the strobe case.
    stubSelection(null, '', true);
    await tick();
    await advance(SELECTION_HIDE_DELAY_MS / 2);
    stubSelection(textNode, 'a longer span');
    await tick();

    // Well past when the original hide would have fired.
    await advance(SELECTION_HIDE_DELAY_MS * 2);
    expect(screen.getByTestId('annotation-add-button')).toBeTruthy();
  });

  it('retires the pill immediately when the editor opens, not after the debounce', async () => {
    const textNode = mountTranscript();
    stubSelection(textNode, 'a span');
    render(React.createElement(AnnotationSelectionLayer, { onAdd: vi.fn() }));
    await tick();

    await act(async () => {
      fireEvent.touchEnd(screen.getByTestId('annotation-add-button'));
    });

    expect(screen.queryByTestId('annotation-add-button')).toBeNull();
    expect(screen.getByTestId('annotation-note-sheet')).toBeTruthy();
  });
});

describe('useMessageAnnotations', () => {
  it('persists annotations to a conversation-scoped localStorage key', () => {
    const { result } = renderHook(() => useMessageAnnotations('conv-abc'));

    act(() => {
      result.current.addAnnotation({ messageId: 'msg-1', quote: LONG_QUOTE, note: 'wrong' });
    });

    expect(result.current.annotations).toHaveLength(1);
    const raw = localStorage.getItem(annotationsStorageKey('conv-abc'));
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)[0].quote).toBe(LONG_QUOTE);
  });

  it('rehydrates from localStorage on mount', () => {
    localStorage.setItem(
      annotationsStorageKey('conv-abc'),
      JSON.stringify([{ id: 'x', messageId: 'm', quote: 'q', note: 'n', createdAt: 5 }]),
    );
    const { result } = renderHook(() => useMessageAnnotations('conv-abc'));
    expect(result.current.annotations).toEqual([
      { id: 'x', messageId: 'm', quote: 'q', note: 'n', createdAt: 5 },
    ]);
  });

  it('keeps conversations separate', () => {
    localStorage.setItem(
      annotationsStorageKey('conv-other'),
      JSON.stringify([{ id: 'y', messageId: 'm', quote: 'q', note: 'n', createdAt: 5 }]),
    );
    const { result } = renderHook(() => useMessageAnnotations('conv-abc'));
    expect(result.current.annotations).toEqual([]);
  });

  it('edits a note in place and ignores an empty edit', () => {
    const { result } = renderHook(() => useMessageAnnotations('conv-abc'));
    act(() => {
      result.current.addAnnotation({ messageId: 'm', quote: 'q', note: 'first' });
    });
    const [added] = result.current.annotations;
    act(() => {
      result.current.updateAnnotation(added.id, '  second  ');
      result.current.updateAnnotation(added.id, '   ');
    });

    expect(result.current.annotations).toEqual([{ ...added, note: 'second' }]);
    expect(JSON.parse(localStorage.getItem(annotationsStorageKey('conv-abc')) as string)[0].note).toBe('second');
  });

  it('drops only the ids that were actually sent', () => {
    const { result } = renderHook(() => useMessageAnnotations('conv-abc'));
    act(() => {
      result.current.addAnnotation({ messageId: 'm', quote: 'first', note: 'one' });
      result.current.addAnnotation({ messageId: 'm', quote: 'second', note: 'two' });
    });
    const [first] = result.current.getPendingAnnotations();

    act(() => {
      result.current.consumeAnnotations([first.id]);
    });

    expect(result.current.annotations.map((a) => a.quote)).toEqual(['second']);
  });

  it('clears state and storage on clearAnnotations', () => {
    const { result } = renderHook(() => useMessageAnnotations('conv-abc'));
    act(() => {
      result.current.addAnnotation({ messageId: 'm', quote: 'q', note: 'n' });
    });
    act(() => {
      result.current.clearAnnotations();
    });
    expect(result.current.annotations).toEqual([]);
    expect(localStorage.getItem(annotationsStorageKey('conv-abc'))).toBeNull();
  });

  it('ignores an annotation with a blank note', () => {
    const { result } = renderHook(() => useMessageAnnotations('conv-abc'));
    act(() => {
      result.current.addAnnotation({ messageId: 'm', quote: 'q', note: '   ' });
    });
    expect(result.current.annotations).toEqual([]);
  });
});

describe('AnnotationStatusBadge', () => {
  const annotations = [
    { id: 'a1', messageId: 'm1', quote: LONG_QUOTE, note: 'note one', createdAt: 1 },
    { id: 'a2', messageId: 'm1', quote: 'short span', note: 'note two', createdAt: 2 },
    { id: 'a3', messageId: 'm2', quote: 'third span', note: 'note three', createdAt: 3 },
  ];

  function renderBadge(overrides: Partial<React.ComponentProps<typeof AnnotationStatusBadge>> = {}) {
    return render(React.createElement(AnnotationStatusBadge, {
      annotations,
      onClearAll: vi.fn(),
      onSendNotesOnly: vi.fn(),
      ...overrides,
    }));
  }

  it('renders nothing when there are no annotations', () => {
    const { container } = renderBadge({ annotations: [] });
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('annotation-status-badge')).toBeNull();
  });

  it('shows the true pending count, including notes whose message is unmounted', () => {
    // No transcript is mounted at all here — the badge is the fallback surface
    // and must still count every pending note.
    renderBadge();
    expect(screen.getByTestId('annotation-status-count').textContent).toBe('3');
    expect(screen.getByTestId('annotation-status-badge').getAttribute('data-pending-count')).toBe('3');
  });

  it('labels itself for screen readers, singular and plural', () => {
    const { rerender } = renderBadge({ annotations: annotations.slice(0, 1) });
    expect(screen.getByTestId('annotation-status-badge').getAttribute('aria-label')).toBe('1 note pending');

    rerender(React.createElement(AnnotationStatusBadge, {
      annotations,
      onClearAll: vi.fn(),
      onSendNotesOnly: vi.fn(),
    }));
    expect(screen.getByTestId('annotation-status-badge').getAttribute('aria-label')).toBe('3 notes pending');
  });

  it('is compact — no quote previews in the status bar', () => {
    renderBadge();
    expect(screen.getByTestId('annotation-status-badge').textContent).not.toContain(LONG_QUOTE);
    expect(screen.queryByTestId('annotation-chip')).toBeNull();
    expect(screen.queryByTestId('annotation-pending-line')).toBeNull();
  });

  it('keeps a 44px tap target despite the small visual', () => {
    renderBadge();
    // Mirrors the toolkit's TOUCH_TARGET_44: a pseudo-element, so no layout cost.
    expect(screen.getByTestId('annotation-status-badge').className).toContain('before:h-11');
  });

  it('opens and closes its popover on tap', () => {
    renderBadge();
    expect(screen.queryByTestId('annotation-status-popover')).toBeNull();

    fireEvent.click(screen.getByTestId('annotation-status-badge'));
    expect(screen.getByTestId('annotation-status-popover')).toBeTruthy();

    fireEvent.click(screen.getByTestId('annotation-status-badge'));
    expect(screen.queryByTestId('annotation-status-popover')).toBeNull();
  });

  it('states the pending count in the popover', () => {
    renderBadge();
    fireEvent.click(screen.getByTestId('annotation-status-badge'));
    expect(screen.getByTestId('annotation-status-popover').textContent).toContain('3 notes pending');
  });

  it('clears all from the popover and closes', () => {
    const onClearAll = vi.fn();
    renderBadge({ onClearAll });
    fireEvent.click(screen.getByTestId('annotation-status-badge'));
    fireEvent.click(screen.getByTestId('annotation-clear-all'));

    expect(onClearAll).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('annotation-status-popover')).toBeNull();
  });

  it('sends notes-only from the popover for the empty-composer case', () => {
    const onSendNotesOnly = vi.fn();
    renderBadge({ onSendNotesOnly });
    fireEvent.click(screen.getByTestId('annotation-status-badge'));
    fireEvent.click(screen.getByTestId('annotation-send-notes'));

    expect(onSendNotesOnly).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('annotation-status-popover')).toBeNull();
  });

  it('disables the send while a permission decision is in flight', () => {
    const onSendNotesOnly = vi.fn();
    renderBadge({ onSendNotesOnly, sendDisabled: true });
    fireEvent.click(screen.getByTestId('annotation-status-badge'));
    fireEvent.click(screen.getByTestId('annotation-send-notes'));

    expect(onSendNotesOnly).not.toHaveBeenCalled();
  });

  it('closes the popover on Escape', () => {
    renderBadge();
    fireEvent.click(screen.getByTestId('annotation-status-badge'));
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(screen.queryByTestId('annotation-status-popover')).toBeNull();
  });

  it('closes the popover when the last note is consumed by a send', () => {
    const { rerender } = renderBadge();
    fireEvent.click(screen.getByTestId('annotation-status-badge'));
    expect(screen.getByTestId('annotation-status-popover')).toBeTruthy();

    rerender(React.createElement(AnnotationStatusBadge, {
      annotations: [],
      onClearAll: vi.fn(),
      onSendNotesOnly: vi.fn(),
    }));

    expect(screen.queryByTestId('annotation-status-popover')).toBeNull();
    expect(screen.queryByTestId('annotation-status-badge')).toBeNull();
  });
});
