/**
 * DOM-side helpers for turning a browser text selection into an annotation
 * target.
 *
 * The transcript is virtualized and renders reversed, so an assistant message
 * can be unmounted at any time. Everything the annotation needs (message id and
 * the quoted string) is therefore resolved eagerly, at selection time, and
 * copied into React state. Nothing downstream holds a live Range or Node.
 */

import {
  buildNormalizedTextIndex,
  normalizedOffsetOfPoint,
  type NormalizedTextIndex,
} from './annotation-range';

export const ASSISTANT_MESSAGE_SELECTOR = '[data-testid="assistant-message"]';
export const MESSAGE_ID_SELECTOR = '[data-message-id]';

/** Nearest Element for a node — text nodes resolve to their parent. */
function toElement(node: Node | null | undefined): Element | null {
  if (!node) return null;
  if (node.nodeType === 1) return node as Element;
  return node.parentElement;
}

/**
 * Walks up from a node to the enclosing assistant message and returns its
 * `data-message-id`. Returns null for user messages, tool cards outside an
 * assistant bubble, composer text, and anything else in the page chrome.
 */
export function resolveAssistantMessageId(node: Node | null | undefined): string | null {
  return resolveAssistantTarget(node)?.id ?? null;
}

/**
 * An annotatable container: the id the annotation is filed under, and the
 * element the quote is searched within. The host must be the same element the
 * highlight resolver later looks inside, or a captured offset would be measured
 * against a different subtree.
 */
export interface AnnotationTarget {
  id: string;
  host: HTMLElement;
}

/** Walks up to the enclosing assistant message. Null for user messages, composer text, page chrome. */
export function resolveAssistantTarget(node: Node | null | undefined): AnnotationTarget | null {
  const element = toElement(node);
  if (!element) return null;
  const assistantRoot = element.closest(ASSISTANT_MESSAGE_SELECTOR);
  if (!assistantRoot) return null;
  const idHost = assistantRoot.closest(MESSAGE_ID_SELECTOR);
  const messageId = idHost?.getAttribute('data-message-id');
  if (!messageId || messageId === '') return null;
  return { id: messageId, host: assistantRoot as HTMLElement };
}

export interface AssistantSelectionTarget {
  /** Id of the annotated container — an assistant message id. */
  messageId: string;
  quote: string;
  /**
   * Where the quote started, as an offset into the container's whitespace-free
   * text. Carried so a phrase that repeats inside one message is annotated on
   * the copy that was selected rather than the first one. Null when the
   * position could not be measured; resolution then falls back to first-match.
   */
  quoteStart: number | null;
  /** Viewport-relative rect of the selection, for positioning the affordance. */
  rect: { top: number; bottom: number; left: number; right: number; width: number } | null;
}

/** A reader turns the live selection into an annotation target, or rejects it. */
export type SelectionReader = (selection: Selection | null | undefined) => AssistantSelectionTarget | null;

/**
 * One-entry memo of the text index, because a drag fires `selectionchange`
 * every frame and the container it walks does not change during one. Same
 * invalidation rule as the highlight resolver: a different host, or the same
 * host with a different amount of text. Holds text nodes for one message until
 * the next selection replaces it.
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

/**
 * Shared core: a selection annotates when it lies wholly inside a single
 * container as judged by `resolveTarget`. Multi-block selections within one
 * container are fine — the quote is just `selection.toString()`.
 */
function readSelectionWithin(
  selection: Selection | null | undefined,
  resolveTarget: (node: Node | null | undefined) => AnnotationTarget | null,
): AssistantSelectionTarget | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const quote = selection.toString();
  if (quote.trim() === '') return null;

  const anchor = resolveTarget(selection.anchorNode);
  if (!anchor) return null;
  const focusId = resolveTarget(selection.focusNode)?.id ?? null;
  // A selection dragged across two containers is ambiguous — ignore it rather
  // than silently attributing the quote to one of them.
  if (focusId !== anchor.id) return null;

  let rect: AssistantSelectionTarget['rect'] = null;
  let quoteStart: number | null = null;
  try {
    // getRangeAt(0) is always in document order, so startContainer is the true
    // start of the span even when the drag went right-to-left.
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
    quoteStart = normalizedOffsetOfPoint(
      indexFor(anchor.host),
      range.startContainer,
      range.startOffset,
    );
  } catch {
    // getBoundingClientRect and Range comparison are unavailable in some test
    // environments; the annotation is still worth capturing without them.
  }

  return { messageId: anchor.id, quote, quoteStart, rect };
}

/** Reads a selection inside a single assistant message. */
export function readAssistantSelection(
  selection: Selection | null | undefined,
): AssistantSelectionTarget | null {
  return readSelectionWithin(selection, resolveAssistantTarget);
}

/** True when the node is inside the annotation UI itself (button, note input). */
export function isInsideAnnotationUi(node: Node | null | undefined): boolean {
  const element = toElement(node);
  return Boolean(element?.closest('[data-annotation-ui="true"]'));
}
