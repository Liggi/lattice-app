/**
 * Turning a text selection inside a rendered article into an ask target.
 *
 * This is the article-surface twin of `readAssistantSelection`: same captured
 * shape (`AssistantSelectionTarget`), same eager capture at selection time, same
 * `quoteStart` measured as an offset into the container's whitespace-free text.
 * `AnnotationSelectionLayer` takes a `readSelection` reader precisely so a
 * second surface can supply its own container rule, so the pill, the editor,
 * the touch docking and the iOS drag-handle debounce all come along unchanged.
 *
 * The `messageId` slot carries the article id — the layer treats it as an
 * opaque key for the annotated container.
 */

import {
  buildNormalizedTextIndex,
  normalizedOffsetOfPoint,
  type NormalizedTextIndex,
} from '../../../utils/annotation-range';
import {
  isInsideAnnotationUi,
  type AssistantSelectionTarget,
  type SelectionReader,
} from '../../../utils/annotation-selection';

/**
 * One-entry memo, for the same reason the annotation reader has one: a drag
 * fires `selectionchange` every frame and the article does not change during
 * it. Invalidated by a different host or a different amount of text.
 */
let memoHost: HTMLElement | null = null;
let memoTextLength = -1;
let memoIndex: NormalizedTextIndex | null = null;

function indexFor(host: HTMLElement): NormalizedTextIndex {
  const textLength = host.textContent?.length ?? 0;
  if (memoIndex && memoHost === host && memoTextLength === textLength) return memoIndex;
  memoIndex = buildNormalizedTextIndex(host);
  memoHost = host;
  memoTextLength = textLength;
  return memoIndex;
}

/** Drops the memo. Call when the article body is replaced. */
export function resetArticleSelectionMemo(): void {
  memoHost = null;
  memoTextLength = -1;
  memoIndex = null;
}

function isInside(host: HTMLElement, node: Node | null | undefined): boolean {
  if (!node) return false;
  return node === host || host.contains(node);
}

/**
 * Builds a reader bound to one article. `getHost` is read on every call rather
 * than captured, so the reader survives the body remounting.
 */
export function createArticleSelectionReader(
  articleId: string,
  getHost: () => HTMLElement | null,
): SelectionReader {
  return (selection): AssistantSelectionTarget | null => {
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

    const host = getHost();
    if (!host) return null;

    const quote = selection.toString();
    if (quote.trim() === '') return null;

    // Both ends inside the article body, and neither inside our own cards —
    // the exchange cards are rendered within the body so they stay next to
    // their span, and quoting one back at the agent is not an article ask.
    if (!isInside(host, selection.anchorNode) || !isInside(host, selection.focusNode)) return null;
    if (isInsideAnnotationUi(selection.anchorNode) || isInsideAnnotationUi(selection.focusNode)) {
      return null;
    }

    let rect: AssistantSelectionTarget['rect'] = null;
    let quoteStart: number | null = null;
    try {
      const range = selection.getRangeAt(0);
      const domRect = range.getBoundingClientRect?.();
      if (domRect && (domRect.width > 0 || domRect.height > 0)) {
        rect = {
          top: domRect.top,
          bottom: domRect.bottom,
          left: domRect.left,
          right: domRect.right,
          width: domRect.width,
        };
      }
      quoteStart = normalizedOffsetOfPoint(indexFor(host), range.startContainer, range.startOffset);
    } catch {
      // Measurement is unavailable in some environments; the quote alone is
      // still a usable ask target.
    }

    return { messageId: articleId, quote, quoteStart, rect };
  };
}
