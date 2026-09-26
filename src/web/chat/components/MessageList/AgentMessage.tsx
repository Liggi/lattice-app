import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { MessageAttribution } from '../../types/index.js';
import { attributionLabel } from '../shared/message-attribution.js';
import { useSenderIdentity } from '../shared/sender-names.js';
import { AddReactionButton, ReactionChips, type ReactionTarget } from '../MessageReactions/MessageReactions';

export interface AgentMessageProps {
  attribution: MessageAttribution;
  /** The message as it was sent; shown in full when opened. */
  text: string;
  /** Images and documents that came with it, rendered when opened. */
  media?: React.ReactNode;
  /** Set when the user can react to it; the reaction goes to the sender. */
  reaction?: ReactionTarget;
}

/**
 * A message another session sent, in the thread where it was delivered. It
 * reads as coordination rather than as something the user typed: its own surface
 * on the left, closed to the sender's name, opening to the message entire.
 */
export function AgentMessage({ attribution, text, media, reaction }: AgentMessageProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const identity = useSenderIdentity(attribution.sender);

  return (
    <div className="flex justify-start w-full my-1" data-testid="agent-message">
      <div className="w-full max-w-[85%]">
        <div className="group/agent rounded-lg border border-line bg-surface">
          <div className="flex items-center pr-1.5">
            <button
              type="button"
              onClick={() => setOpen(previous => !previous)}
              aria-expanded={open}
              data-testid="agent-message-summary"
              // The id stays the identity even when the line shows a name.
              title={attribution.sender ?? undefined}
              className="flex min-w-0 flex-1 items-center gap-2 px-3.5 py-2 text-left"
            >
              <ChevronDown
                size={14}
                className={`flex-shrink-0 text-fg-3 transition-transform ${open ? '' : '-rotate-90'}`}
              />
              <span data-testid="message-attribution" className="text-[12px] font-medium text-fg-3">
                {attributionLabel(attribution, identity)}
              </span>
            </button>
            {reaction && (
              <AddReactionButton
                target={reaction}
                className="opacity-100 sm:opacity-0 sm:group-hover/agent:opacity-100 data-[state=open]:opacity-100"
              />
            )}
          </div>
          {open && (
            // Bounded so one long instruction cannot take the thread over; the
            // name above stays put, so closing it is always one tap away.
            <div
              data-testid="agent-message-body"
              className="max-h-[38vh] overflow-y-auto border-t border-line px-3.5 py-2.5"
            >
              {media && <div className="flex flex-wrap gap-2 mb-2">{media}</div>}
              <div className="whitespace-pre-wrap break-words text-sm leading-[1.55] text-fg">{text}</div>
            </div>
          )}
        </div>
        {reaction && <ReactionChips target={reaction} ringed className="relative -mt-2 ml-2" />}
      </div>
    </div>
  );
}
