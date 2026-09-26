// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';
import {
  isInsideAnnotationUi,
  readAssistantSelection,
  resolveAssistantMessageId,
} from '../../src/web/chat/utils/annotation-selection.js';

/**
 * Mirrors the real render path: MessageList puts `data-message-id` on the outer
 * wrapper and MessageItem puts `data-testid="assistant-message"` inside it.
 */
function buildTranscript(): void {
  document.body.innerHTML = `
    <div id="scroll">
      <div data-message-id="msg-assistant-1">
        <div class="w-full max-w-5xl px-4 py-1">
          <div data-testid="assistant-message">
            <p id="para-a">The retry loop is unbounded.</p>
            <p id="para-b">It will spin forever on a 500.</p>
          </div>
        </div>
      </div>
      <div data-message-id="msg-user-1">
        <div class="w-full max-w-5xl px-4 py-1">
          <div data-testid="user-message"><p id="para-user">please fix</p></div>
        </div>
      </div>
      <div data-message-id="msg-assistant-2">
        <div class="w-full max-w-5xl px-4 py-1">
          <div data-testid="assistant-message"><p id="para-c">Done.</p></div>
        </div>
      </div>
      <div data-annotation-ui="true"><span id="ui-child">Add note</span></div>
      <p id="outside">page chrome</p>
    </div>
  `;
}

/**
 * Minimal stand-in for the browser Selection. readAssistantSelection only reads
 * these members, so this keeps the test independent of happy-dom's Selection
 * completeness.
 */
function stubSelection(params: {
  anchorNode: Node | null;
  focusNode?: Node | null;
  text: string;
  isCollapsed?: boolean;
}): Selection {
  return {
    isCollapsed: params.isCollapsed ?? false,
    rangeCount: 1,
    anchorNode: params.anchorNode,
    focusNode: params.focusNode ?? params.anchorNode,
    toString: () => params.text,
    getRangeAt: () => {
      throw new Error('no range in this environment');
    },
  } as unknown as Selection;
}

/**
 * Same stub, but carrying a real Range — the path that measures where in the
 * message the quote started.
 */
function stubSelectionWithRange(params: {
  startId: string;
  startOffset: number;
  endId: string;
  endOffset: number;
  text: string;
}): Selection {
  const range = document.createRange();
  range.setStart(textNode(params.startId), params.startOffset);
  range.setEnd(textNode(params.endId), params.endOffset);
  return {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: textNode(params.startId),
    focusNode: textNode(params.endId),
    toString: () => params.text,
    getRangeAt: () => range,
  } as unknown as Selection;
}

function textNode(id: string): Node {
  const element = document.getElementById(id);
  if (!element || !element.firstChild) throw new Error(`missing text node for #${id}`);
  return element.firstChild;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('resolveAssistantMessageId', () => {
  it('resolves the message id from a text node inside an assistant message', () => {
    buildTranscript();
    expect(resolveAssistantMessageId(textNode('para-a'))).toBe('msg-assistant-1');
    expect(resolveAssistantMessageId(textNode('para-c'))).toBe('msg-assistant-2');
  });

  it('resolves from an element node as well as a text node', () => {
    buildTranscript();
    expect(resolveAssistantMessageId(document.getElementById('para-b'))).toBe('msg-assistant-1');
  });

  it('rejects user messages even though they carry a message id', () => {
    buildTranscript();
    expect(resolveAssistantMessageId(textNode('para-user'))).toBeNull();
  });

  it('rejects nodes outside any message', () => {
    buildTranscript();
    expect(resolveAssistantMessageId(textNode('outside'))).toBeNull();
    expect(resolveAssistantMessageId(null)).toBeNull();
  });
});

describe('readAssistantSelection', () => {
  it('returns the message id and the exact selected text', () => {
    buildTranscript();
    const result = readAssistantSelection(
      stubSelection({ anchorNode: textNode('para-a'), text: 'retry loop is unbounded' }),
    );
    expect(result).toEqual({
      messageId: 'msg-assistant-1',
      quote: 'retry loop is unbounded',
      quoteStart: null,
      rect: null,
    });
  });

  it('records where in the message the quote started', () => {
    buildTranscript();
    // "Theretryloopisunbounded." is 24 characters, so the second paragraph
    // starts at 24 in the message's whitespace-free text.
    const result = stubSelectionWithRange({
      startId: 'para-b',
      startOffset: 8,
      endId: 'para-b',
      endOffset: 13,
      text: 'spin ',
    });
    // Offset 8 in "It will spin…" is the "s", 6 real characters into that block.
    expect(readAssistantSelection(result)?.quoteStart).toBe(24 + 6);
  });

  it('measures from the start of the span even when the drag ran backwards', () => {
    buildTranscript();
    // anchorNode is the later paragraph (where the drag began), focusNode the
    // earlier one; the Range is still in document order.
    const range = document.createRange();
    range.setStart(textNode('para-a'), 4);
    range.setEnd(textNode('para-b'), 7);
    const backwards = {
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: textNode('para-b'),
      focusNode: textNode('para-a'),
      toString: () => 'retry loop is unbounded.\nIt will',
      getRangeAt: () => range,
    } as unknown as Selection;
    expect(readAssistantSelection(backwards)?.quoteStart).toBe(3);
  });

  it('leaves the position null when the environment has no usable range', () => {
    buildTranscript();
    const result = readAssistantSelection(
      stubSelection({ anchorNode: textNode('para-a'), text: 'retry loop' }),
    );
    expect(result?.quoteStart).toBeNull();
  });

  it('accepts a selection spanning several blocks of one assistant message', () => {
    buildTranscript();
    const result = readAssistantSelection(
      stubSelection({
        anchorNode: textNode('para-a'),
        focusNode: textNode('para-b'),
        text: 'unbounded.\nIt will spin',
      }),
    );
    expect(result?.messageId).toBe('msg-assistant-1');
    expect(result?.quote).toBe('unbounded.\nIt will spin');
  });

  it('rejects a selection dragged across two different messages', () => {
    buildTranscript();
    const result = readAssistantSelection(
      stubSelection({
        anchorNode: textNode('para-a'),
        focusNode: textNode('para-c'),
        text: 'spans two messages',
      }),
    );
    expect(result).toBeNull();
  });

  it('rejects collapsed, empty, whitespace-only, and absent selections', () => {
    buildTranscript();
    expect(readAssistantSelection(null)).toBeNull();
    expect(readAssistantSelection(undefined)).toBeNull();
    expect(
      readAssistantSelection(stubSelection({ anchorNode: textNode('para-a'), text: 'x', isCollapsed: true })),
    ).toBeNull();
    expect(readAssistantSelection(stubSelection({ anchorNode: textNode('para-a'), text: '' }))).toBeNull();
    expect(readAssistantSelection(stubSelection({ anchorNode: textNode('para-a'), text: '  \n ' }))).toBeNull();
  });

  it('rejects a selection inside a user message', () => {
    buildTranscript();
    expect(
      readAssistantSelection(stubSelection({ anchorNode: textNode('para-user'), text: 'please fix' })),
    ).toBeNull();
  });

  it('keeps the quote verbatim, including leading and trailing whitespace', () => {
    buildTranscript();
    const result = readAssistantSelection(
      stubSelection({ anchorNode: textNode('para-a'), text: '  The retry loop  ' }),
    );
    expect(result?.quote).toBe('  The retry loop  ');
  });
});

describe('isInsideAnnotationUi', () => {
  it('is true for nodes inside the annotation affordance', () => {
    buildTranscript();
    expect(isInsideAnnotationUi(document.getElementById('ui-child'))).toBe(true);
  });

  it('is false for transcript nodes', () => {
    buildTranscript();
    expect(isInsideAnnotationUi(textNode('para-a'))).toBe(false);
    expect(isInsideAnnotationUi(null)).toBe(false);
  });
});
