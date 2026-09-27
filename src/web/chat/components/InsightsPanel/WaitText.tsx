/**
 * A wait phrase with its conversation ids made readable.
 *
 * Workers and the coordinator write their waits as free text, and name the
 * session they wait on by its raw id ("conv-CYr0hqzWOxrh's hover shot"), or
 * by a short prefix of it ("CYr0's next restart").
 * A worker on this project reads "a worker", underlined; hovering it lights
 * that worker's card, or names its task when it is archived and has no card.
 * The coordinator reads "the coordinator".
 * Any other id reads "another session", with the id itself on hover: the panel
 * knows nothing else about it, and a guessed name would be wrong.
 */

import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/web/chat/components/ui/tooltip';
import type { WorkerCardState } from '@/types/worker-events';

export interface WaitTextContext {
  workers: Pick<WorkerCardState, 'worker' | 'task' | 'archived'>[];
  coordinatorId?: string;
  onPointWorker?: (worker: string | null) => void;
}

// A whole id, or a short one: some workers write "CYr0" for conv-CYr0hqzWOxrh.
const ID_TOKEN = /(?<![A-Za-z0-9_-])((?:conv-)?[A-Za-z0-9_-]{4,})(['’]s\b)?/g;

/** The worker a token names: its whole id, or a prefix of exactly one worker's id. */
function workerFor<W extends { worker: string }>(token: string, workers: W[]): W | undefined {
  const exact = workers.find((candidate) => candidate.worker === token);
  if (exact) return exact;
  const prefix = token.startsWith('conv-') ? token : `conv-${token}`;
  const matches = workers.filter((candidate) => candidate.worker.startsWith(prefix));
  return matches.length === 1 ? matches[0] : undefined;
}

export function WaitText({ text, workers, coordinatorId, onPointWorker }: { text: string } & WaitTextContext): JSX.Element {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(ID_TOKEN)) {
    const index = match.index ?? 0;
    const id = match[1];
    const possessive = match[2] ?? '';
    const worker = workerFor(id, workers);
    // A short token that names no single worker is an ordinary word.
    if (!worker && !id.startsWith('conv-')) continue;
    parts.push(text.slice(last, index));
    last = index + match[0].length;
    if (worker) {
      const reference = (
        <span
          key={index}
          data-testid="wait-worker-ref"
          onMouseEnter={() => onPointWorker?.(worker.worker)}
          onMouseLeave={() => onPointWorker?.(null)}
          className="cursor-default underline decoration-dotted decoration-[1.5px] underline-offset-[3px] hover:decoration-solid"
          style={{ textDecorationColor: 'color-mix(in srgb, currentColor 55%, transparent)' }}
        >
          a worker{possessive}
        </span>
      );
      // A current worker's lit card already shows its task; an archived one
      // has no card, so its task comes up beside the reference instead.
      parts.push(worker.archived ? (
        <Tooltip key={index} delayDuration={300}>
          <TooltipTrigger asChild>{reference}</TooltipTrigger>
          <TooltipContent side="top">{worker.task}</TooltipContent>
        </Tooltip>
      ) : reference);
    } else if (id === coordinatorId) {
      parts.push(`the coordinator${possessive}`);
    } else {
      parts.push(
        <Tooltip key={index} delayDuration={300}>
          <TooltipTrigger asChild>
            <span
              className="cursor-default underline decoration-dotted decoration-[1.5px] underline-offset-[3px]"
              style={{ textDecorationColor: 'color-mix(in srgb, currentColor 55%, transparent)' }}
            >
              another session{possessive}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="font-mono">{id}</TooltipContent>
        </Tooltip>,
      );
    }
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}
