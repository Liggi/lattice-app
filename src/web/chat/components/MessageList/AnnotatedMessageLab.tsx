import React from 'react';
import { Link } from 'react-router-dom';
import { MessageItem } from './MessageItem';
import type { ChatMessage } from '../../types';
import { formatAnnotatedMessage, type PendingAnnotation } from '../../utils/annotations-format';

// ============================================================
// Fixture data only. No session is read or written by this page.
// ============================================================

function pending(quote: string, note: string, i: number): PendingAnnotation {
  return { id: `n${i}`, messageId: 'm', quote, note, createdAt: i };
}

const LONG_PASSAGE = 'I left the permission-routing edits on main alone because they belong to another session, and branched from the last commit instead. The worktree lives next to the main checkout and shares its node_modules through a symlink, so nothing had to be reinstalled. When the branch is ready, it can be rebased onto whatever main looks like then, and the permission-routing work will not be touched by it at any point.';

const FIXTURES: ReadonlyArray<{ caption: string; text: string }> = [
  {
    caption: 'one note, short passage',
    text: formatAnnotatedMessage([pending('its card shows "Nothing will wake it"', '.... why?', 1)], ''),
  },
  {
    caption: 'three notes, one long passage, then typed text',
    text: formatAnnotatedMessage(
      [
        pending('the retry loop backs off to 30 seconds and then gives up', 'giving up silently is the bug — it should say so on the card', 1),
        pending(LONG_PASSAGE, 'good, keep doing that', 2),
        pending('two of the eleven tests are skipped', 'which two, and why?', 3),
      ],
      'Otherwise this looks right. Go ahead with the retry fix.',
    ),
  },
];

function userMessage(text: string, i: number): ChatMessage {
  return { id: `lab-${i}`, messageId: `lab-${i}`, type: 'user', content: text, timestamp: new Date().toISOString() };
}

/** A sent message carrying notes on the agent's reply, through the real MessageItem. `/lab/annotated-message`. */
export function AnnotatedMessageLab(): JSX.Element {
  return (
    <div className="h-full w-full overflow-y-auto bg-bg text-fg">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6 flex flex-col gap-8">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[11px] uppercase tracking-wider text-fg-2">Notes on a reply</h1>
          <Link to="/" className="text-xs text-accent">back to app</Link>
        </div>
        {FIXTURES.map(({ caption, text }, i) => (
          <div key={caption} className="flex flex-col gap-3">
            <div className="text-[11px] uppercase tracking-wider text-fg-3">{caption}</div>
            <MessageItem message={userMessage(text, i)} />
          </div>
        ))}
      </div>
    </div>
  );
}
