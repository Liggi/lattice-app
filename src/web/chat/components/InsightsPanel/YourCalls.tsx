/**
 * The rows of the panel's Your calls list (`types/your-calls.ts` says what is
 * listed and how it fades). A tap opens a row into the chat's decision card,
 * in place: the ask becomes the heading, the card's options sit under it,
 * and "What was this?" shows what the thread says about itself. A thread
 * with an ask (`note --ask`) opens onto it, in full, in a popover left of
 * the panel (a sheet over it on a phone): the context and the questions,
 * written for the user. An answer is
 * held a few seconds before it goes (`held-replies.ts`), with Undo, and the
 * row then says it was sent and folds away.
 *
 * Park and Dismiss are on hover on a desktop (icons in place of the age) and
 * on a swipe left on a phone (the text wraps to make room); both end in the
 * panel's parked/dismissed row with Undo.
 */

import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, CheckCircle2, ChevronLeft, Clock3, Pencil, Undo2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkSlackBullets } from '../../utils/slack-bullets';
import { markdownComponents } from '../MessageList/MessageItem';
import { SessionStateIcon } from '@/web/chat/components/shared/session-state-icon/SessionStateIcon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/web/chat/components/ui/tooltip';
import { Popover, PopoverAnchor, PopoverContent } from '@/web/chat/components/ui/popover';
import { parseAsk, type ParsedAsk } from '@/types/ask-text';
import { AskAnswers, AskWords } from './AskAnswers';
import { CALL_LEAVE_MS, type Call, type CallStage } from '@/types/your-calls';
import { formatAgo } from '@/types/project-state';
import type { ReplyTarget } from '@/types/held-replies';

const HOUR = 60 * 60 * 1000;
/** How far a row slides before its Park and Dismiss show on a touch screen. */
const SWIPE_OPEN_PX = 48;

async function post(path: string, body?: unknown): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (response.ok) return;
  const parsed = await response.json().catch(() => null) as { error?: string } | null;
  throw new Error(parsed?.error ?? `HTTP ${response.status}`);
}

export function holdReply(coordinatorId: string, target: ReplyTarget, text: string): Promise<void> {
  return post(`/api/conv/${encodeURIComponent(coordinatorId)}/project/replies`, { target, text });
}

export function undoReply(coordinatorId: string, id: string): Promise<void> {
  return post(`/api/conv/${encodeURIComponent(coordinatorId)}/project/replies/${encodeURIComponent(id)}/undo`);
}

export function threadAction(coordinatorId: string, seq: number, action: 'dismiss' | 'park' | 'restore'): Promise<void> {
  return post(`/api/conv/${encodeURIComponent(coordinatorId)}/project/threads/${seq}/${action}`);
}

const TONE: Record<CallStage, { name: string; ask: string; age: string }> = {
  fresh: { name: 'text-fg font-medium', ask: 'text-fg-2', age: 'text-fg-3' },
  recent: { name: 'text-fg-2 font-medium', ask: 'text-fg-3', age: 'text-fg-3/70' },
  fading: { name: 'text-fg-3', ask: 'text-fg-3/70', age: 'text-fg-3/50' },
};

function StageIcon({ stage, waited }: { stage: CallStage; waited: number }) {
  // Fresh calls are the sidebar's Needs you amber, dimming over their hour; then a still grey cube.
  if (stage === 'fresh') return <SessionStateIcon state={{ kind: 'needs-you', strength: Math.max(0.2, 1 - waited / HOUR) }} variant="session" size={18} />;
  return (
    <span className={stage === 'recent' ? 'opacity-45' : 'opacity-25'}>
      <SessionStateIcon state={{ kind: 'idle' }} variant="session" size={stage === 'recent' ? 18 : 16} />
    </span>
  );
}

const Icon = ({ children }: { children: React.ReactNode }) => <span className="flex h-6 w-7 shrink-0 items-center justify-center">{children}</span>;

/**
 * Opens and closes with a height transition. Closed content is unmounted
 * once it has folded away, so each opening starts fresh.
 */
function Unfold({ open, children }: { open: boolean; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setExpanded(true));
      return () => cancelAnimationFrame(frame);
    }
    setExpanded(false);
    const timer = setTimeout(() => setMounted(false), 220);
    return () => clearTimeout(timer);
  }, [open]);
  if (!mounted) return null;
  return (
    <div className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
      <div className="min-h-0 overflow-hidden" {...(open ? {} : { inert: '' })}>{children}</div>
    </div>
  );
}

export interface CallActions {
  onAnswer: (call: Call, text: string) => Promise<void>;
  onUndo: (call: Call, heldId: string) => Promise<void>;
  onPark?: (call: Call) => void;
  onDismiss: (call: Call) => void;
}

export function CallRow({ call, now, open, onToggle, actions }: {
  call: Call;
  now: number;
  open: boolean;
  onToggle: () => void;
  actions: CallActions;
}): JSX.Element {
  const leaving = call.sent !== null && now - call.sent.at > CALL_LEAVE_MS - 400;
  if (call.held || call.sent) {
    return (
      <Unfold open={!leaving}>
        <SettledRow call={call} onUndo={call.held ? () => actions.onUndo(call, call.held!.id) : undefined} />
      </Unfold>
    );
  }
  return <OpenableRow call={call} now={now} open={open} onToggle={onToggle} actions={actions} />;
}

/** Answered, from the card's answered form: the tick, the answer, and Undo until it goes. */
function SettledRow({ call, onUndo }: { call: Call; onUndo?: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const text = call.held ? call.held.text : call.sent?.text ?? null;
  const dismissal = call.held !== null && call.held.text === null;
  return (
    <div data-testid="call-settled" className="rounded-md bg-surface-2/60">
      <div className="flex items-start gap-2.5 px-2 py-1.5">
        <Icon>{dismissal ? <X size={15} className="text-fg-3" /> : <CheckCircle2 size={15} className="text-emerald-400" />}</Icon>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-3">
            <span className="min-w-0 flex-1 text-[13px] leading-[1.45] text-fg-3 break-words">{call.name}</span>
            {onUndo && (
              <button
                type="button"
                data-testid="call-undo"
                onClick={() => { setError(null); onUndo().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))); }}
                className="-my-1 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[12.5px] font-medium text-accent hover:bg-accent/10"
              >
                <Undo2 size={13} aria-hidden /> Undo
              </button>
            )}
          </span>
          <span className="text-[13px] leading-[1.45] break-words">
            {dismissal ? <span className="text-fg-2">Dismissed</span> : text && <span className="whitespace-pre-line font-medium text-fg">{text}</span>}
            <span className="ml-2 text-fg-3">{call.held ? 'sending' : 'sent'}</span>
          </span>
          {error && <span className="mt-0.5 text-[12px] text-rose-400">Could not undo: {error}</span>}
        </span>
      </div>
    </div>
  );
}

function OpenableRow({ call, now, open, onToggle, actions }: {
  call: Call;
  now: number;
  open: boolean;
  onToggle: () => void;
  actions: CallActions;
}) {
  const waited = now - call.since;
  const [revealed, setRevealed] = useState(false);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const park = call.thread && actions.onPark ? () => { setRevealed(false); actions.onPark!(call); } : undefined;
  const dismiss = () => { setRevealed(false); actions.onDismiss(call); };
  const dismissLabel = call.workers === 0 ? 'Dismiss' : call.workers === 1 ? 'Dismiss and stop its worker' : 'Dismiss and stop its workers';
  // A row with an ask opens away from the panel; one with numbered questions lays them out.
  const asks = Boolean(call.askText);
  const ask = call.askText ? parseAsk(call.askText) : null;
  const rowRef = useRef<HTMLDivElement>(null);
  const desktop = useDesktopRow(rowRef, open && asks);

  useEffect(() => {
    // The popover closes itself on Escape.
    if (!open || desktop) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onToggle(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onToggle, desktop]);

  const row = (
    <div
      ref={rowRef}
      data-testid="call-row"
      data-open={open || undefined}
      className={`group relative flex items-stretch overflow-hidden rounded-md transition-colors duration-200 ${open ? 'bg-surface-2' : revealed ? 'bg-surface-2/50' : 'hover:bg-surface-2'}`}
      onTouchStart={(event) => { touch.current = { x: event.touches[0].clientX, y: event.touches[0].clientY }; }}
      onTouchEnd={(event) => {
        const start = touch.current;
        touch.current = null;
        if (!start || open) return;
        const dx = event.changedTouches[0].clientX - start.x;
        const dy = event.changedTouches[0].clientY - start.y;
        if (Math.abs(dx) < SWIPE_OPEN_PX || Math.abs(dy) > Math.abs(dx)) return;
        setRevealed(dx < 0);
      }}
    >
      <div className="min-w-0 flex-1">
        <RowHead call={call} waited={waited} open={open && !asks} revealed={revealed} onToggle={() => (revealed ? setRevealed(false) : onToggle())} />
        {!revealed && !open && <HoverActions park={park} dismiss={dismiss} dismissLabel={dismissLabel} />}
        {!asks && (
          <Unfold open={open}>
            <OpenCall call={call} actions={actions} onPark={park} onDismiss={dismiss} />
          </Unfold>
        )}
      </div>
      <div className={`flex shrink-0 overflow-hidden transition-[width] duration-200 ease-out ${revealed ? (park ? 'w-[136px]' : 'w-[68px]') : 'w-0'}`} aria-hidden={!revealed}>
        {park && (
          <button type="button" tabIndex={revealed ? 0 : -1} onClick={park} className="flex w-[68px] shrink-0 flex-col items-center justify-center gap-1 bg-white/[0.07] text-[12px] font-medium text-fg">
            <Clock3 size={18} strokeWidth={1.75} aria-hidden /> Park
          </button>
        )}
        <button type="button" tabIndex={revealed ? 0 : -1} onClick={dismiss} className="flex w-[68px] shrink-0 flex-col items-center justify-center gap-1 bg-white/[0.13] text-[12px] font-medium text-fg">
          <X size={18} strokeWidth={1.75} aria-hidden /> Dismiss
        </button>
      </div>
    </div>
  );
  if (!asks) return row;

  return (
    <Popover open={open && desktop} onOpenChange={(next) => { if (!next && open) onToggle(); }}>
      <PopoverAnchor asChild>{row}</PopoverAnchor>
      <PopoverContent
        side="left"
        align="start"
        sideOffset={14}
        collisionPadding={16}
        onOpenAutoFocus={(event) => event.preventDefault()}
        // A click on the row is its own toggle, not a click outside.
        onInteractOutside={(event) => { if (rowRef.current?.contains(event.target as Node)) event.preventDefault(); }}
        className="w-[440px] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto border-white/[0.08] bg-surface-2 p-0 shadow-2xl shadow-black/50"
      >
        <AskCall call={call} ask={ask} waited={waited} actions={actions} onPark={park} onDismiss={dismiss} />
      </PopoverContent>
      {open && !desktop && (
        <div className="fixed inset-0 z-[60] flex flex-col bg-bg md:hidden" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
          <div className="flex shrink-0 items-center border-b border-line px-2 py-2">
            <button type="button" onClick={onToggle} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[13px] font-medium text-fg-2 hover:text-fg">
              <ChevronLeft size={18} aria-hidden /> Your calls
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            <AskCall call={call} ask={ask} waited={waited} actions={actions} onPark={park} onDismiss={dismiss} sheet />
          </div>
        </div>
      )}
    </Popover>
  );
}

/** The row's name, age and ask, the whole row a toggle. */
function RowHead({ call, waited, open, revealed, onToggle }: { call: Call; waited: number; open: boolean; revealed: boolean; onToggle: () => void }) {
  const tone = TONE[call.stage];
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={onToggle}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(); } }}
      className={`flex cursor-pointer items-start gap-2.5 px-2 outline-none focus-visible:bg-surface-2 ${call.stage === 'fading' && !open ? 'py-1' : 'py-1.5'}`}
    >
      <Icon><StageIcon stage={call.stage} waited={waited} /></Icon>
      <span className="flex min-w-0 flex-1 flex-col justify-center">
        <span className="flex items-baseline gap-3">
          <span className={`min-w-0 flex-1 text-[13px] leading-[1.45] break-words ${open ? 'font-medium text-fg-2' : tone.name}`}>{call.name}</span>
          <span className={`relative shrink-0 font-mono text-[11px] tabular-nums ${tone.age} ${revealed || open ? '' : '[@media(hover:hover)]:group-hover:invisible'}`} title="How long it has waited on you">
            {formatAgo(waited)}
          </span>
        </span>
        {call.ask && (open
          ? <span className="mt-0.5 text-[15px] font-medium leading-[1.45] text-fg break-words">{call.ask}</span>
          : call.stage !== 'fading' && <span className={`text-[12.5px] leading-[1.4] break-words ${tone.ask}`}>{call.ask}</span>)}
        {call.error && !open && <span className="mt-0.5 text-[12px] text-rose-400">Not sent: {call.error}</span>}
      </span>
    </div>
  );
}

/** A row, open, lays its ask out in a popover on a desktop; true once its row is the one on screen there. */
function useDesktopRow(ref: React.RefObject<HTMLElement | null>, wanted: boolean): boolean {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    if (!wanted) return;
    // The panel is drawn twice, for a phone and a desktop; only the one on screen opens.
    const query = window.matchMedia('(min-width: 768px)');
    const check = () => setDesktop(query.matches && ref.current?.offsetParent != null);
    check();
    query.addEventListener('change', check);
    return () => query.removeEventListener('change', check);
  }, [ref, wanted]);
  return desktop;
}

/**
 * An ask, opened: in a popover left of the panel on a desktop, as a sheet
 * over the panel on a phone. Numbered questions are answered in place; any
 * other ask shows as written with one box. Sending closes it, and the row
 * then holds the answer with Undo as any other.
 */
function AskCall({ call, ask, waited, actions, onPark, onDismiss, sheet = false }: {
  call: Call;
  ask: ParsedAsk | null;
  waited: number;
  actions: CallActions;
  onPark?: () => void;
  onDismiss: () => void;
  sheet?: boolean;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = (text: string) => {
    setSending(true);
    setError(null);
    actions.onAnswer(call, text).catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)); setSending(false); });
  };
  const quiet = 'flex items-center gap-1 rounded-md px-2 py-1.5 text-[12.5px] text-fg-3 hover:text-fg-2';
  const footer = (
    <>
      {onPark && <button type="button" onClick={onPark} disabled={sending} className={`-ml-2 ${quiet}`}><Clock3 size={13} strokeWidth={1.75} aria-hidden /> Park</button>}
      <button type="button" onClick={onDismiss} disabled={sending} className={onPark ? quiet : `-ml-2 ${quiet}`}><X size={13} strokeWidth={1.75} aria-hidden /> Dismiss</button>
    </>
  );
  return (
    <div className={sheet ? 'p-4' : 'p-5'}>
      <p className="text-[13px] leading-[1.45] text-fg-3 break-words">
        {call.name}
        <span className="ml-2 tabular-nums" title="How long it has waited on you">{formatAgo(waited)}</span>
      </p>
      {call.ask && <h3 className="mb-3 mt-1 text-[17px] font-semibold leading-[1.35] text-fg break-words">{call.ask}</h3>}
      {ask
        ? <AskAnswers ask={ask} sending={sending} onSend={send} footer={footer} />
        : <AskWords text={call.askText ?? ''} sending={sending} onSend={send} footer={footer} />}
      {error && <p className="mt-1.5 text-[12.5px] text-rose-400">Not sent: {error}</p>}
    </div>
  );
}

/**
 * On a pointer, Park and Dismiss as icons where the age was, each named in its
 * tooltip. The tooltip opens to their left, over the row being pointed at,
 * so it never covers the row above or below.
 */
function HoverActions({ park, dismiss, dismissLabel }: { park?: () => void; dismiss: () => void; dismissLabel: string }) {
  const button = (label: string, tip: string, onClick: () => void, icon: React.ReactNode) => (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-testid={`call-${label.toLowerCase().split(' ')[0]}`}
          onClick={(event) => { event.stopPropagation(); onClick(); }}
          className="flex h-7 w-7 items-center justify-center rounded-md text-fg-2 hover:bg-white/[0.08] hover:text-fg"
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={6} className="whitespace-nowrap py-1">{tip}</TooltipContent>
    </Tooltip>
  );
  return (
    <span className="absolute right-1 top-1 hidden items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:flex">
      {park && button('Park', 'Park for later', park, <Clock3 size={15} strokeWidth={1.75} />)}
      {button(dismissLabel, `${dismissLabel}: you don't need it`, dismiss, <X size={15} strokeWidth={1.75} />)}
    </span>
  );
}

const OPTION = 'w-full rounded-md border px-3 py-2 text-left transition-colors';
const OPTION_IDLE = 'border-white/[0.08] bg-stone-900/50 hover:border-cyan-400/50 hover:bg-cyan-400/10';
const OPTION_CHOSEN = 'border-cyan-400/50 bg-cyan-400/10';

/** The opened row: the card's options (or a reply box), then the ways out. */
function OpenCall({ call, actions, onPark, onDismiss }: {
  call: Call;
  actions: CallActions;
  onPark?: () => void;
  onDismiss: () => void;
}) {
  const [pressed, setPressed] = useState<string | null>(null);
  const [writing, setWriting] = useState(!call.decision);
  const [words, setWords] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [briefOpen, setBriefOpen] = useState(false);

  const answer = async (text: string, label: string) => {
    setPressed(label);
    setError(null);
    try {
      await actions.onAnswer(call, text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPressed(null);
    }
  };

  return (
    <div className="pb-2 pl-[46px] pr-2 pt-1.5">
      {call.askText && (
        <div data-testid="call-ask" className="prose prose-sm mb-3 max-w-none text-[13.5px] leading-[1.55] text-fg dark:prose-invert break-words">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkSlackBullets]} components={markdownComponents}>{call.askText}</ReactMarkdown>
        </div>
      )}
      {briefOpen && call.brief && <Brief brief={call.brief} />}
      {call.decision && (
        <div className="flex flex-col gap-1.5">
          {call.decision.options.map((option) => {
            const chosen = pressed === option.label;
            return (
              <button
                key={option.label}
                type="button"
                data-testid="call-option"
                disabled={pressed !== null}
                onClick={() => void answer(option.label, option.label)}
                style={{ touchAction: 'manipulation' }}
                className={`${OPTION} ${chosen ? OPTION_CHOSEN : OPTION_IDLE} ${pressed && !chosen ? 'opacity-40' : ''}`}
              >
                <span className="flex items-baseline gap-3">
                  <span className="min-w-0 flex-1 text-[13.5px] font-medium leading-[1.5] text-fg">{option.label}</span>
                  {chosen ? <span className="shrink-0 text-[11px] text-cyan-400">Sending</span> : option.recommended && <span className="shrink-0 text-[11px] text-fg-3">Recommended</span>}
                </span>
                <span className="mt-0.5 block text-[12.5px] leading-[1.45] text-fg-2">{option.consequence}</span>
              </button>
            );
          })}
        </div>
      )}
      {writing ? (
        <form
          className={`flex flex-col gap-1.5 ${call.decision ? 'mt-2' : ''}`}
          onSubmit={(event) => { event.preventDefault(); if (words.trim()) void answer(words.trim(), '__words'); }}
        >
          <textarea
            value={words}
            onChange={(event) => setWords(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit(); }}
            rows={2}
            autoFocus={Boolean(call.decision)}
            disabled={pressed !== null}
            aria-label="Your answer"
            placeholder="Your answer"
            className="w-full resize-y rounded-md border border-white/[0.08] bg-bg/70 px-3 py-2 text-[13.5px] leading-[1.5] text-fg placeholder:text-fg-3 focus:border-cyan-400/50 focus:outline-none"
          />
          <span className="flex items-center justify-end gap-1">
            {call.decision && (
              <button type="button" onClick={() => setWriting(false)} disabled={pressed !== null} className="rounded-md px-2.5 py-1.5 text-[13px] text-fg-3 hover:text-fg-2">Cancel</button>
            )}
            <button type="submit" disabled={pressed !== null || !words.trim()} className="rounded-md bg-cyan-400/10 px-3 py-1.5 text-[13px] font-medium text-cyan-400 hover:bg-cyan-400/20 disabled:opacity-50">
              {pressed === '__words' ? 'Sending' : 'Send'}
            </button>
          </span>
        </form>
      ) : (
        <button type="button" onClick={() => setWriting(true)} disabled={pressed !== null} className="-ml-2 mt-1 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] text-fg-3 hover:text-fg-2">
          <Pencil size={12} aria-hidden /> Answer in your own words
        </button>
      )}
      {error && <p className="mt-1.5 text-[12.5px] text-rose-400">Not sent: {error}</p>}
      {pressed === null && (
        <div className="mt-1 flex items-center border-t border-white/[0.06] pt-1">
          {call.brief && !call.askText && (
            <button type="button" data-testid="call-brief-toggle" onClick={() => setBriefOpen((value) => !value)} className="-ml-2 flex items-center gap-1.5 rounded-md px-2 py-2 text-[12.5px] font-medium text-fg-2 hover:text-fg">
              <BookOpen size={13} strokeWidth={1.75} aria-hidden /> {briefOpen ? 'Hide' : 'What was this?'}
            </button>
          )}
          <span className="flex-1" />
          {onPark && (
            <button type="button" onClick={onPark} className="flex items-center gap-1 rounded-md px-2 py-2 text-[12.5px] text-fg-3 hover:text-fg-2">
              <Clock3 size={13} strokeWidth={1.75} aria-hidden /> Park
            </button>
          )}
          <button type="button" onClick={onDismiss} className="-mr-2 flex items-center gap-1 rounded-md px-2 py-2 text-[12.5px] text-fg-3 hover:text-fg-2">
            <X size={13} strokeWidth={1.75} aria-hidden /> Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

/** What the thread says about itself: where the work has got to and its next step. */
function Brief({ brief }: { brief: NonNullable<Call['brief']> }) {
  return (
    <div data-testid="call-brief" className="mb-2.5 flex flex-col gap-1.5 rounded-md bg-bg/60 px-3 py-2.5 text-[13px] leading-[1.5]">
      {brief.summary && <p className="text-fg break-words">{brief.summary}</p>}
      {brief.next && <p className="text-fg-2 break-words"><span className="text-fg-3">Next: </span>{brief.next}</p>}
    </div>
  );
}

/** Parked or dismissed from a row: it says so in place, with Undo. */
export function GoneRow({ name, word, error, onUndo }: { name: string; word: string; error?: string; onUndo: () => void }): JSX.Element {
  return (
    <div data-testid="call-gone" className="flex items-center gap-2.5 px-2 py-1.5 text-[12.5px]">
      <span className="w-7 shrink-0" />
      {error ? (
        <span className="flex-1 text-rose-400">Could not {word === 'parked' ? 'park' : 'dismiss'} it: {error}</span>
      ) : (
        <>
          <span className="min-w-0 flex-1 break-words"><span className="text-fg-2">{name}</span><span className="ml-2 text-fg-3">{word}</span></span>
          <button type="button" data-testid="call-gone-undo" onClick={onUndo} className="flex shrink-0 items-center gap-1 font-medium text-accent hover:underline">
            <Undo2 size={12} aria-hidden /> Undo
          </button>
        </>
      )}
    </div>
  );
}
