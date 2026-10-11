/**
 * A wait phrase with its conversation ids made readable.
 *
 * Workers and the coordinator write their waits as free text, and name the
 * session they wait on by its raw id ("conv-CYr0hqzWOxrh's hover shot"), or
 * by a short prefix of it ("CYr0's next restart").
 * The id never shows. It reads as the session's name when that is short, and
 * as "a worker" or "another session" when it is not; an id in brackets after
 * words that already name the session ("the playset worker (conv-…)") is
 * dropped and those words carry the reference. Hovering it, or a first tap
 * on a phone, fades the rest of the panel around it and its row when that
 * row is on this panel and in view, and otherwise names
 * the session in full, with its project when it is in another one. A click, or a second tap, opens it. An id no
 * session has says so instead.
 * The coordinator reads "the coordinator".
 */

import React, { useEffect, useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/web/chat/components/ui/tooltip';
import type { SessionReference, WorkerCardState } from '@/types/worker-events';

export interface WaitTextContext {
  workers: Pick<WorkerCardState, 'worker' | 'task' | 'archived'>[];
  coordinatorId?: string;
  /** Names for the other sessions the waits mention, from `GET /workers`. */
  references?: Record<string, SessionReference>;
  onPointWorker?: (worker: string | null) => void;
  onOpenSession?: (conversationId: string) => void;
}

// A whole id, or a short one: some workers write "CYr0" for conv-CYr0hqzWOxrh.
const ID_TOKEN = /(?<![A-Za-z0-9_-])((?:conv-)?[A-Za-z0-9_-]{4,})(['’]s\b)?/g;

// A name longer than this reads as a sentence dropped into the line.
const MAX_INLINE_NAME = 40;

// Words that open a noun phrase naming a session: "the playset worker".
const DETERMINER = /^(the|a|an|my|your|its|their|this|that|front['’]s)$/i;
const MAX_PHRASE_WORDS = 5;
// A phrase ending on one of these names nothing: "a reply from (conv-…)".
const FUNCTION_WORD = /^(from|to|on|of|for|by|with|and|or|in|at|than|after|before|until|is|are|was)$/i;

/** The worker a token names: its whole id, or a prefix of exactly one worker's id. */
function workerFor<W extends { worker: string }>(token: string, workers: W[]): W | undefined {
  const exact = workers.find((candidate) => candidate.worker === token);
  if (exact) return exact;
  const prefix = token.startsWith('conv-') ? token : `conv-${token}`;
  const matches = workers.filter((candidate) => candidate.worker.startsWith(prefix));
  return matches.length === 1 ? matches[0] : undefined;
}

interface Target {
  id: string;
  /** Null when nothing names the session, or no session has the id. */
  name: string | null;
  project: string | null;
  onPanel: boolean;
  found: boolean;
}

/**
 * Where the words before "(" that name the session begin, or -1. Walks back
 * a few words to a determiner, so "the playset worker" yields the start of
 * "the".
 */
function phraseStart(before: string): number {
  const words = [...before.matchAll(/\S+/g)];
  if (words.length === 0 || FUNCTION_WORD.test(words[words.length - 1][0])) return -1;
  for (let back = 1; back <= Math.min(MAX_PHRASE_WORDS, words.length); back++) {
    const word = words[words.length - back];
    if (/[.,;:!?()]$/.test(word[0])) return -1;
    if (DETERMINER.test(word[0])) return word.index ?? -1;
  }
  return -1;
}

function inlineLabel(target: Target): string {
  if (target.name && target.name.length <= MAX_INLINE_NAME) return target.name;
  if (!target.found) return 'an unknown session';
  if (target.onPanel) return 'a worker';
  if (target.project && `a session in ${target.project}`.length <= MAX_INLINE_NAME) return `a session in ${target.project}`;
  return 'another session';
}

/** Whether the worker's row is wholly on screen in the panel being shown. */
function inView(worker: string): boolean {
  return [...document.querySelectorAll<HTMLElement>(`[data-testid="worker-card"][data-worker="${CSS.escape(worker)}"]`)].some((row) => {
    if (row.offsetParent === null) return false;
    const box = row.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= window.innerHeight;
  });
}

function SessionRef({ target, children, onPointWorker, onOpenSession }: {
  target: Target;
  children: React.ReactNode;
} & Pick<WaitTextContext, 'onPointWorker' | 'onOpenSession'>): JSX.Element {
  const [open, setOpen] = useState(false);
  // A row in view, lit, already shows the task; the name would cover it.
  const [rowInView, setRowInView] = useState(false);
  // A tap shows what a hover would; the trigger's own tap must not close it.
  const tapped = useRef(false);
  // Only a row in view is lit; one scrolled away is named in the tooltip.
  const point = (on: boolean) => {
    if (!target.onPanel) return;
    const lit = on && inView(target.id);
    if (on) setRowInView(lit);
    onPointWorker?.(lit ? target.id : null);
  };
  const show = (next: boolean) => {
    if (!next && tapped.current) return;
    setOpen(next);
    point(next);
  };
  // With the tooltip held shut the primitive reports no leave or outside
  // tap, so the reference ends its own pointing.
  const trigger = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (trigger.current?.contains(event.target as Node)) return;
      tapped.current = false;
      show(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  });
  const openable = target.found && Boolean(onOpenSession);
  const lit = open && target.onPanel && rowInView;
  return (
    <Tooltip open={open && !(target.onPanel && rowInView)} onOpenChange={show} delayDuration={300}>
      <TooltipTrigger asChild>
        <span
          data-testid="wait-session-ref"
          data-session={target.id}
          role={openable ? 'link' : undefined}
          ref={trigger}
          onPointerDown={(event) => { tapped.current = event.pointerType === 'touch'; }}
          onMouseLeave={() => { if (!tapped.current) show(false); }}
          onClick={(event) => {
            // The row is a button that opens the waiting worker; this opens the session it waits on.
            event.stopPropagation();
            event.preventDefault();
            const touch = tapped.current;
            setTimeout(() => { tapped.current = false; }, 0);
            if (touch && !open) {
              setOpen(true);
              point(true);
              return;
            }
            if (openable) onOpenSession?.(target.id);
          }}
          data-ref-active={lit || undefined}
          className={`${openable ? 'cursor-pointer' : 'cursor-default'} underline decoration-[1.5px] underline-offset-[3px] ${lit ? 'decoration-solid' : 'decoration-dotted hover:decoration-solid'}`}
          style={lit ? undefined : { textDecorationColor: 'color-mix(in srgb, currentColor 55%, transparent)' }}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" data-testid="wait-session-ref-tip">
        {target.found ? (
          <>
            <span className="block text-fg">{target.name ?? 'A session with no name yet'}</span>
            {target.project && <span className="block text-fg-3">In {target.project}</span>}
          </>
        ) : (
          <span className="block text-fg-2">Lattice has no session with this id, so it can't say which one is meant.</span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export function WaitText({ text, workers, coordinatorId, references, onPointWorker, onOpenSession }: { text: string } & WaitTextContext): JSX.Element {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(ID_TOKEN)) {
    const index = match.index ?? 0;
    const id = match[1];
    const possessive = match[2] ?? '';
    const worker = workerFor(id, workers);
    // A short token that names no single worker is an ordinary word.
    if (!worker && !id.startsWith('conv-')) continue;
    const reference = worker ? null : references?.[id];
    // The coordinator is this panel's own session; until the server has
    // answered about any other id there is nothing true to say about it.
    if (!worker && (id === coordinatorId || !reference)) {
      parts.push(text.slice(last, index), `${id === coordinatorId ? 'the coordinator' : 'another session'}${possessive}`);
      last = index + match[0].length;
      continue;
    }
    const target: Target = worker
      ? { id: worker.worker, name: worker.task, project: null, onPanel: true, found: true }
      : { id, name: reference!.name, project: reference!.project, onPanel: false, found: reference!.found };
    const ref = { target, onPointWorker, onOpenSession };

    // "the playset worker (conv-…)": the words already name it.
    const bracketed = text[index - 1] === '(' && text[index + match[0].length] === ')' && !possessive;
    const before = text.slice(last, bracketed ? index - 1 : index);
    const phrase = before.trimEnd();
    const start = bracketed ? phraseStart(phrase) : -1;
    if (start >= 0) {
      parts.push(before.slice(0, start), <SessionRef key={index} {...ref}>{phrase.slice(start)}</SessionRef>);
      last = index + match[0].length + 1;
      continue;
    }
    parts.push(before);
    if (bracketed) parts.push('(');
    parts.push(<SessionRef key={index} {...ref}>{inlineLabel(target)}{possessive}</SessionRef>);
    last = index + match[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}
