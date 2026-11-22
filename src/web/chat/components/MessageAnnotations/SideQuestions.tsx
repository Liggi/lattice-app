import React, { type JSX, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, Check, CornerDownLeft, Maximize2, MessageCircleQuestion, Minimize2, X } from 'lucide-react';
import { ConversationView } from '../ConversationView/ConversationView';
import { useCoarsePointer, useVisualViewport } from '../../hooks/useVisualViewport';
import type { SideQuestion, SideQuestionsApi } from '../../hooks/useSideQuestions';
import { computeKeyboardInset, shouldDockAnnotationUi } from '../../utils/annotation-viewport';
import { isInsideAnnotationUi, type AssistantSelectionTarget } from '../../utils/annotation-selection';
import { NoteMarkdown } from '../LearningMap/article/ArticleMarkdown';
import { hitTestPlacements } from './AnnotationSpanIcons';
import { ANNOTATION_PANEL_HEADER, ANNOTATION_PANEL_LABEL } from './annotation-styles';
import {
  SIDE_QUESTION_ACTIVE_HIGHLIGHT_NAME,
  SIDE_QUESTION_HIGHLIGHT_NAME,
  supportsHighlightApi,
  useAnnotationHighlights,
  type AnnotationSpanPlacement,
} from './useAnnotationHighlights';

const DRAFT_ID = 'side-question-draft';
const POPOVER_WIDTH = 480;
const POPOVER_HEIGHT = 460;
/** Below this the popover is too short to read an answer in; it opens above the passage instead. */
const POPOVER_MIN_HEIGHT = 280;
/** Expanded, the popover grows to this, floating over the thread, as far as the thread's area allows. */
const EXPANDED_WIDTH = 760;
const EXPANDED_HEIGHT = 820;
/** The thread stays in sight round an expanded dialog, so it reads as a dialog, not a panel. */
const EXPANDED_MARGIN = 32;
const GAP = 8;
const EDGE = 12;
const SHEET_SHARE = 0.62;

/** `key` names one opening of the panel, so a draft that becomes a chat keeps its state and focus. */
type Open = ({ kind: 'draft'; target: AssistantSelectionTarget } | { kind: 'chat'; id: string }) & { key: number };

interface SideQuestionsProps {
  api: SideQuestionsApi;
  /** A passage the user just pressed Ask on; opens an empty side chat about it. */
  draft: AssistantSelectionTarget | null;
  onDraftHandled: () => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

function setActive(range: Range | null): void {
  if (!supportsHighlightApi()) return;
  try {
    if (range) CSS.highlights.set(SIDE_QUESTION_ACTIVE_HIGHLIGHT_NAME, new Highlight(range));
    else CSS.highlights.delete(SIDE_QUESTION_ACTIVE_HIGHLIGHT_NAME);
  } catch {
    // Decorative only.
  }
}

/** The block the passage ends in, so a panel placed under it never cuts a line. */
function blockOf(range: Range): Element | null {
  const node = range.endContainer;
  const element = node.nodeType === 1 ? node as Element : node.parentElement;
  return element?.closest('p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, table') ?? element;
}

function transcript(): HTMLElement | null {
  return document.querySelector('[data-testid="message-list"]');
}

/**
 * Side chats about passages of the agent's messages: the marked passages, the
 * small question icon in the margin beside each, and the open side chat — a
 * popover under the passage on desktop, a bottom sheet on the phone. Expanded,
 * the popover is a larger dialog over the thread and the sheet takes the whole
 * phone screen; it is the same chat either way.
 */
export function SideQuestions({ api, draft, onDraftHandled, expanded, onExpandedChange }: SideQuestionsProps): JSX.Element | null {
  const { sideQuestions } = api;
  const [open, setOpen] = useState<Open | null>(null);
  const openings = useRef(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const viewport = useVisualViewport();
  const docked = shouldDockAnnotationUi(useCoarsePointer(), viewport.width);

  useEffect(() => {
    if (!draft) return;
    setOpen({ kind: 'draft', target: draft, key: ++openings.current });
    onDraftHandled();
  }, [draft, onDraftHandled]);

  const entries = useMemo(() => {
    const list = sideQuestions.map((sq) => ({ id: sq.id, messageId: sq.messageId, quote: sq.quote, quoteStart: sq.quoteStart ?? undefined }));
    if (open?.kind === 'draft') {
      list.push({ id: DRAFT_ID, messageId: open.target.messageId, quote: open.target.quote, quoteStart: open.target.quoteStart ?? undefined });
    }
    return list;
  }, [sideQuestions, open]);
  const placements = useAnnotationHighlights(entries, undefined, SIDE_QUESTION_HIGHLIGHT_NAME);
  const placementsRef = useRef(placements);
  placementsRef.current = placements;

  const openId = open?.kind === 'draft' ? DRAFT_ID : open?.id ?? null;
  const openPlacement = placements.find((p) => p.annotationId === openId) ?? null;

  useEffect(() => {
    const id = openId ?? hovered;
    setActive(placements.find((p) => p.annotationId === id)?.range ?? null);
  }, [openId, hovered, placements]);
  useEffect(() => () => setActive(null), []);

  const openChat = useCallback((id: string) => {
    if (id === DRAFT_ID) return;
    window.getSelection()?.removeAllRanges();
    setOpen({ kind: 'chat', id, key: ++openings.current });
    setHovered(null);
  }, []);
  const openChatRef = useRef(openChat);
  openChatRef.current = openChat;
  const close = useCallback(() => {
    setOpen(null);
    onExpandedChange(false);
  }, [onExpandedChange]);

  // Hover (mouse) strengthens a marked passage; a click or tap on it reopens its side chat.
  useEffect(() => {
    if (docked) return;
    let frame = 0;
    let last: PointerEvent | null = null;
    const update = () => {
      frame = 0;
      if (!last || isInsideAnnotationUi(last.target as Node)) return;
      const hit = hitTestPlacements(placementsRef.current.filter((p) => p.annotationId !== DRAFT_ID), last.clientX, last.clientY);
      setHovered(hit?.annotationId ?? null);
      document.body.style.cursor = hit ? 'pointer' : '';
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      last = event;
      if (!frame) frame = requestAnimationFrame(update);
    };
    document.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener('pointermove', onMove);
      document.body.style.cursor = '';
    };
  }, [docked]);
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (isInsideAnnotationUi(target)) return;
      if (target?.closest?.('a, button, input, textarea, [role="button"]')) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const hit = hitTestPlacements(placementsRef.current.filter((p) => p.annotationId !== DRAFT_ID), event.clientX, event.clientY);
      if (hit) openChatRef.current(hit.annotationId);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  // Escape closes, unless something in the side chat (a menu, the composer) used it.
  // A press on the thread closes the popover; the sheet has its own backdrop,
  // and the expanded dialog has its own backdrop too.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) close();
    };
    const onDown = (event: Event) => {
      if (docked || expanded) return;
      const target = event.target as Element | null;
      // Only the thread: the side chat's own menus are portalled outside it, and must not close it.
      if (!target?.closest?.('[role="main"]') || isInsideAnnotationUi(target)) return;
      const pointer = event as PointerEvent;
      // A press on a marked passage reopens that one rather than closing.
      if (hitTestPlacements(placementsRef.current, pointer.clientX, pointer.clientY)) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open, docked, expanded, close]);

  // While a side chat is open, its question count is kept current, so Add to thread knows what is new.
  const openChatId = open?.kind === 'chat' ? open.id : null;
  const { refresh } = api;
  useEffect(() => {
    if (!openChatId) return;
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [openChatId, refresh]);

  const openSideQuestion = open?.kind === 'chat' ? sideQuestions.find((sq) => sq.id === open.id) ?? null : null;

  const chat = open ? (
    <SideChat
      key={open.key}
      sideQuestion={openSideQuestion}
      quote={open.kind === 'draft' ? open.target.quote : openSideQuestion?.quote ?? ''}
      showPassage={docked || expanded}
      expanded={expanded}
      onToggleExpanded={() => onExpandedChange(!expanded)}
      onClose={close}
      onAsk={async (question) => {
        if (open.kind !== 'draft') return;
        const sideQuestion = await api.ask({ messageId: open.target.messageId, quote: open.target.quote, quoteStart: open.target.quoteStart, question });
        setOpen((current) => current?.kind === 'draft' && current.key === open.key ? { kind: 'chat', id: sideQuestion.id, key: current.key } : current);
      }}
      onAddToThread={() => openSideQuestion ? api.addToThread(openSideQuestion.id) : Promise.resolve()}
    />
  ) : null;

  return (
    <>
      {/* The full-height sheet covers the thread, so the thread's icons are not shown beside it. */}
      {!(docked && expanded && open) && placements.filter((p) => p.annotationId !== DRAFT_ID).map((placement) => (
        <MarginMarker key={placement.annotationId} placement={placement} onOpen={openChat} />
      ))}
      {chat && (docked
        ? <SideSheet range={openPlacement?.range ?? null} full={expanded} onClose={close}>{chat}</SideSheet>
        : <SidePopover range={openPlacement?.range ?? null} host={openPlacement?.host ?? null} expanded={expanded} onClose={close}>{chat}</SidePopover>)}
    </>
  );
}

/**
 * The question icon beside a marked passage, in the margin right of the
 * message on the passage's last line. In the margin rather than in the text,
 * so react-markdown's DOM is never touched: a reply still streaming re-renders
 * its paragraph, and a node inserted into it would garble the text.
 */
function MarginMarker({ placement, onOpen }: { placement: AnnotationSpanPlacement; onOpen: (id: string) => void }): JSX.Element | null {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const rects = placement.range.getClientRects();
      const lastLine = rects[rects.length - 1];
      if (!lastLine) return;
      const host = placement.host.getBoundingClientRect();
      // Just right of the text column: the paragraph's edge, not the message's, which runs wider.
      const textRight = blockOf(placement.range)?.getBoundingClientRect().right ?? host.right;
      // On a phone the text runs to the margin, so the icon sits in the margin's last 15px.
      const left = Math.min(textRight - host.left + 6, window.innerWidth - host.left - 16);
      const next = { top: lastLine.top - host.top + (lastLine.height - 16) / 2, left };
      setPosition((current) => current && current.top === next.top && current.left === next.left ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(placement.host);
    return () => observer.disconnect();
  }, [placement]);
  if (!position) return null;
  return createPortal(
    <button
      type="button"
      data-annotation-ui="true"
      data-testid="side-question-marker"
      aria-label="Open side question"
      onClick={() => onOpen(placement.annotationId)}
      className="absolute flex h-4 w-[14px] items-center justify-start text-accent"
      style={{ top: position.top, left: position.left }}
    >
      <MessageCircleQuestion size={12} />
    </button>,
    placement.host,
  );
}

/** Re-render on any scroll or resize, so a panel tied to a passage follows it. */
function useLayoutTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let frame = 0;
    const bump = () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; setTick((t) => t + 1); });
    };
    window.addEventListener('scroll', bump, true);
    window.addEventListener('resize', bump);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', bump, true);
      window.removeEventListener('resize', bump);
    };
  }, []);
  return tick;
}

/**
 * Desktop: under the paragraph the passage ends in, starting under the passage
 * inside the message column, at one fixed height so a follow-up scrolls inside it and its edges
 * never move. It stops above the composer. When the passage sits too low for
 * that, the thread is scrolled up to make room once; when it cannot scroll
 * far enough (the passage is in the last reply), the popover opens above the
 * passage instead. Either way the passage stays uncovered.
 *
 * Expanded, it is a larger dialog over a dimmed page, centred right of the
 * sidebar between the top of the thread and the composer; it carries the
 * passage itself, and a press on the dimmed page closes it.
 */
function SidePopover({ range, host, expanded, onClose, children }: { range: Range | null; host: HTMLElement | null; expanded: boolean; onClose: () => void; children: React.ReactNode }): JSX.Element | null {
  const tick = useLayoutTick();
  const scrolledRef = useRef(false);
  const [placement, setPlacement] = useState<{ top: number; left: number; width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    if (expanded) {
      const area = transcript()?.getBoundingClientRect();
      if (!area) return;
      const floor = (document.querySelector('[data-composer-box="true"]')?.getBoundingClientRect().top ?? window.innerHeight) - EDGE;
      const ceiling = area.top + EXPANDED_MARGIN;
      // Centred right of the sidebar, over the side panel too: on a laptop with both panels open the thread alone is barely wider than the popover.
      const room = window.innerWidth - area.left;
      const width = Math.min(EXPANDED_WIDTH, room - 2 * EXPANDED_MARGIN);
      const height = Math.min(EXPANDED_HEIGHT, floor - ceiling);
      const value = {
        top: Math.round(ceiling + (floor - ceiling - height) / 2),
        left: Math.round(area.left + (room - width) / 2),
        width,
        height,
      };
      setPlacement((current) => current && current.top === value.top && current.left === value.left && current.height === value.height && current.width === value.width ? current : value);
      return;
    }
    if (!range || !host) return;
    const block = blockOf(range)?.getBoundingClientRect();
    const first = range.getClientRects()[0];
    if (!block || !first) return;
    const column = host.getBoundingClientRect();
    const floor = (document.querySelector('[data-composer-box="true"]')?.getBoundingClientRect().top ?? window.innerHeight) - EDGE;
    const ceiling = (transcript()?.getBoundingClientRect().top ?? 0) + EDGE;
    const below = floor - (block.bottom + GAP);
    if (below < POPOVER_MIN_HEIGHT && !scrolledRef.current) {
      scrolledRef.current = true;
      const list = transcript();
      // As far as the room needs, but never so far that the passage leaves the top.
      const scroll = Math.min(Math.min(POPOVER_HEIGHT, POPOVER_MIN_HEIGHT * 1.4) - below, first.top - ceiling - EDGE);
      if (list && scroll > 0) {
        const before = list.scrollTop;
        list.scrollBy({ top: scroll });
        // A thread already at its end does not move, and no scroll event will place the popover.
        if (list.scrollTop !== before) return;
      }
    }
    const width = Math.min(POPOVER_WIDTH, column.width);
    const above = first.top - GAP - ceiling;
    let next;
    if (below >= POPOVER_MIN_HEIGHT || below >= above) {
      next = { top: block.bottom + GAP, height: Math.min(POPOVER_HEIGHT, below) };
    } else {
      const height = Math.min(POPOVER_HEIGHT, above);
      next = { top: first.top - GAP - height, height };
    }
    // Starts under the passage, held inside the message column.
    const left = Math.max(column.left, Math.min(first.left - 12, column.right - width));
    const value = { ...next, left, width };
    setPlacement((current) => current && current.top === value.top && current.left === value.left && current.height === value.height && current.width === value.width ? current : value);
  }, [range, host, expanded, tick]);

  if (!placement) return null;
  return createPortal(
    <>
      {expanded && <div className="fixed inset-0 z-40 bg-black/45" data-annotation-ui="true" onClick={onClose} />}
      <div
        data-annotation-ui="true"
        data-side-chat="true"
        data-testid="side-question-popover"
        className="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-line-2 bg-surface shadow-[0_12px_40px_rgba(0,0,0,0.55)]"
        style={placement}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

/**
 * Phone: a bottom sheet over a dimmed thread, one height whatever it holds;
 * expanded, it takes the whole screen. The thread gets room at its foot the
 * height of the sheet while it is open, so a passage near the end can scroll
 * clear of it.
 */
function SideSheet({ range, full, onClose, children }: { range: Range | null; full: boolean; onClose: () => void; children: React.ReactNode }): JSX.Element {
  const viewport = useVisualViewport();
  const keyboard = computeKeyboardInset(viewport.layoutHeight, viewport);
  const height = Math.round(viewport.layoutHeight * SHEET_SHARE);
  const shown = full ? viewport.height - 2 * EDGE : Math.min(height, viewport.height - 2 * EDGE);

  useLayoutEffect(() => {
    const list = transcript();
    if (!list) return;
    const previous = list.style.paddingBottom;
    list.style.paddingBottom = `${height}px`;
    // The padding itself moves the thread (it is anchored at its foot), so the
    // passage is measured after it and brought to just above the sheet if it
    // is not already in the visible strip.
    if (range) {
      const passage = range.getBoundingClientRect();
      const sheetTop = viewport.layoutHeight - height - EDGE;
      const listTop = list.getBoundingClientRect().top;
      if (passage.top < listTop + EDGE || passage.bottom > sheetTop - EDGE) {
        list.scrollBy({ top: passage.bottom - (sheetTop - 2 * EDGE) });
      }
    }
    return () => { list.style.paddingBottom = previous; };
    // Only when the sheet opens: the thread is the user's to scroll after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <>
      <div className="fixed inset-0 z-40 bg-black/45" data-annotation-ui="true" onClick={onClose} />
      <div
        data-annotation-ui="true"
        data-side-chat="true"
        data-testid="side-question-sheet"
        className="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-line-2 bg-surface"
        style={{ left: EDGE, right: EDGE, bottom: keyboard + EDGE, height: shown, touchAction: 'manipulation' }}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

interface SideChatProps {
  sideQuestion: SideQuestion | null;
  quote: string;
  showPassage: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onClose: () => void;
  onAsk: (question: string) => Promise<void>;
  onAddToThread: () => Promise<void>;
}

/** The passage as shown above the chat: a selection that stops mid-sentence ends with an ellipsis. */
function passageText(quote: string): string {
  const text = quote.trim();
  return /[.!?:;)\]"'”’…]$/.test(text) ? text : `${text}…`;
}

const HEADER_BUTTON = 'flex h-7 w-7 items-center justify-center rounded-sm text-fg-3 hover:bg-surface-2 hover:text-fg';

function SideChat({ sideQuestion, quote, showPassage, expanded, onToggleExpanded, onClose, onAsk, onAddToThread }: SideChatProps): JSX.Element {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passageOpen, setPassageOpen] = useState(false);
  // Added means everything asked so far is in the thread; a later follow-up can be added too.
  const pending = sideQuestion ? sideQuestion.questionCount - sideQuestion.addedCount : 0;
  const added = Boolean(sideQuestion?.addedCount) && pending === 0;
  const canAdd = Boolean(sideQuestion?.sideConversationId) && pending > 0 && !adding;

  const add = async () => {
    setAdding(true);
    setError(null);
    try {
      await onAddToThread();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={ANNOTATION_PANEL_HEADER}>
        <MessageCircleQuestion size={12} className="flex-shrink-0 text-fg-3" />
        <span className={`${ANNOTATION_PANEL_LABEL} mr-auto`}>Side question</span>
        <button
          type="button"
          data-testid="side-question-add"
          disabled={!canAdd}
          onClick={() => void add()}
          className={`flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs font-medium transition-colors duration-100 ${canAdd ? 'text-fg-2 hover:bg-surface-2 hover:text-fg' : 'text-fg-3'}`}
        >
          {added ? <Check size={13} /> : <CornerDownLeft size={13} />}
          {added ? 'Added to thread' : adding ? 'Adding…' : 'Add to thread'}
        </button>
        <button
          type="button"
          data-testid="side-question-expand"
          aria-label={expanded ? 'Make smaller' : 'Expand'}
          title={expanded ? 'Make smaller' : 'Expand'}
          onClick={onToggleExpanded}
          className={HEADER_BUTTON}
        >
          {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        <button type="button" aria-label="Close" onClick={onClose} className={HEADER_BUTTON}>
          <X size={14} />
        </button>
      </div>
      {/* Where the passage is out of sight (the phone's sheet, the expanded dialog), the chat carries it. */}
      {showPassage && (
        <button
          type="button"
          data-testid="side-question-passage"
          title={quote}
          aria-expanded={passageOpen}
          onClick={() => setPassageOpen((open) => !open)}
          className="flex-shrink-0 border-b border-line px-4 py-2 text-left text-[13px] leading-[1.5] text-fg-2"
        >
          <span className={passageOpen ? 'block max-h-[40vh] overflow-y-auto' : 'line-clamp-2'}>{passageText(quote)}</span>
        </button>
      )}
      {error && <div className="flex-shrink-0 px-3 pt-1.5 text-xs text-fg-2">{error}</div>}
      {sideQuestion?.sideConversationId ? (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ConversationView key={sideQuestion.sideConversationId} conversationId={sideQuestion.sideConversationId} embedded />
        </div>
      ) : sideQuestion ? (
        <EarlierSideChat sideQuestion={sideQuestion} />
      ) : (
        <FirstQuestion onAsk={onAsk} />
      )}
    </div>
  );
}

/** Until the side chat exists: the first question, and the wait while its session starts. */
function FirstQuestion({ onAsk }: { onAsk: (question: string) => Promise<void> }): JSX.Element {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = async () => {
    const question = draft.trim();
    if (!question || sending !== null) return;
    setSending(question);
    setError(null);
    setDraft('');
    try {
      await onAsk(question);
    } catch (err) {
      setDraft(question);
      setSending(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        {sending !== null && (
          <>
            <div className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-surface-2 px-3 py-2 text-[13px] leading-[1.5] text-fg">{sending}</div>
            </div>
            <div className="text-[13px] leading-[1.6] text-fg-3">Starting the side chat…</div>
          </>
        )}
      </div>
      {error && <div className="px-3 pb-1.5 text-xs text-fg-2">{error}</div>}
      <div className="px-2 pb-2">
        <div className="flex items-end gap-2 rounded-md border border-line bg-bg px-3 py-1.5 focus-within:border-line-2">
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder="Ask about this passage"
            className="max-h-24 min-h-[28px] flex-1 resize-none bg-transparent py-1 text-[13px] leading-[1.5] text-fg outline-none placeholder:text-fg-3"
          />
          <button
            type="button"
            aria-label="Send"
            data-testid="side-question-send"
            disabled={!draft.trim() || sending !== null}
            onClick={() => void submit()}
            className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-sm ${draft.trim() && sending === null ? 'text-accent hover:bg-surface-2' : 'text-fg-3'}`}
          >
            <ArrowUp size={15} />
          </button>
        </div>
      </div>
    </>
  );
}

/** A side chat from before side chats were sessions: its questions and answers, to read. */
function EarlierSideChat({ sideQuestion }: { sideQuestion: SideQuestion }): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
      {sideQuestion.exchanges.map((exchange, index) => (
        <React.Fragment key={`${index}-${exchange.askedAt}`}>
          <div className="flex justify-end">
            <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-surface-2 px-3 py-2 text-[13px] leading-[1.5] text-fg">{exchange.question}</div>
          </div>
          {exchange.answer !== null ? (
            <div className="text-[13px] leading-[1.6] text-fg [&_.prose]:text-[13px] [&_code]:text-[12px]"><NoteMarkdown content={exchange.answer} /></div>
          ) : (
            <div className="text-[13px] leading-[1.6] text-fg-2">{exchange.error ?? 'No answer was saved.'}</div>
          )}
        </React.Fragment>
      ))}
      <div className="text-xs text-fg-3">This side chat is from before side chats could carry on, so it can be read but not continued.</div>
    </div>
  );
}
