import React from 'react';
import type { PendingInput } from '../../hooks/useHarnessSession';
import { AgentMessage } from '../MessageList/AgentMessage';
import { attachmentMedia } from '../MessageList/MessageItem';

export interface QueuedMessagesProps {
  /** In the order sent; the next message to be taken is first. */
  messages: PendingInput[];
}

/**
 * Messages the session has not taken in yet, faded above the composer as they
 * will look in the thread, as the old Lattice showed them. Each drops into the
 * thread when the session reads it; nothing here says when that will be.
 * Another agent's message keeps its closed one-line entry, so a coordinator's
 * backlog cannot cover what the worker is doing, and the stack scrolls inside
 * its own bound rather than pushing the conversation off screen.
 */
export function QueuedMessages({ messages }: QueuedMessagesProps): JSX.Element | null {
  if (messages.length === 0) return null;

  return (
    <div data-testid="queued-messages" className="w-full max-w-3xl px-4 mb-2 max-h-[30vh] overflow-y-auto">
      {messages.map((pm) => {
        const mediaBlocks = (pm.attachments ?? []).filter((block) => block.type === 'image' || block.type === 'document');
        const media = mediaBlocks.length > 0 ? attachmentMedia(mediaBlocks) : undefined;
        return (
        <div key={`pending-${pm.inputEvent.seq}`} data-testid="pending-message">
          <div className="opacity-60">
            {pm.attribution ? (
              <AgentMessage attribution={pm.attribution} text={pm.text} media={media} />
            ) : (
              <div className="flex justify-end w-full my-1">
                <div className="max-w-[85%] min-w-[100px] rounded-lg bg-surface px-3.5 py-2.5 text-sm leading-[1.55] text-fg">
                  {media && <div className="flex flex-wrap gap-2 mb-2">{media}</div>}
                  <div className="whitespace-pre-wrap break-words">{pm.text}</div>
                </div>
              </div>
            )}
          </div>
          {/* Only a message that could not be handed over says anything. */}
          {pm.undeliverable && (
            <div
              data-testid="pending-message-delivery"
              className={`mb-1 text-[11px] leading-[1.4] text-rose-400 ${pm.attribution ? 'text-left' : 'text-right'}`}
            >
              {`Not delivered — ${pm.undeliverable.replace(/\.$/, '')}. It will be tried again at the next turn.`}
            </div>
          )}
        </div>
        );
      })}
    </div>
  );
}
