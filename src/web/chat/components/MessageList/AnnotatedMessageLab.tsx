import React, { useMemo } from 'react';
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

/** Notes on screenshots as the send path writes them: a line per box naming the attached marked copy. */
const SCREENSHOT_NOTES = formatAnnotatedMessage(
  [
    pending('Screenshot: Step 4: proposed replay result before Put live (/tmp/saf156/step4-desktop.png); box at x 1521–2315, y 1778–1940 px, drawn on attached image 1', "This reply still says the edge; the fix needs to cover 'feels close' too.", 1),
    pending('Screenshot: Step 4: proposed replay result before Put live (/tmp/saf156/step4-desktop.png); box at x 2203–2359, y 2540–2626 px, drawn on attached image 2', 'Grey this out until the pairs above have been read.', 2),
  ],
  '',
);

/** A stand-in for a marked copy: a 1400×900 grey page with a cyan box drawn on it. */
function markedCopy(box: [number, number, number, number]): string {
  if (typeof document === 'undefined') return '';
  const canvas = document.createElement('canvas');
  canvas.width = 1400;
  canvas.height = 900;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#f4f1ec';
  ctx.fillRect(0, 0, 1400, 900);
  ctx.fillStyle = '#d9d4cc';
  for (let y = 80; y < 860; y += 70) ctx.fillRect(120, y, 700 + ((y * 37) % 400), 22);
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.strokeRect(...box);
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#22d3ee';
  ctx.strokeRect(...box);
  return canvas.toDataURL('image/png').split(',')[1] ?? '';
}

function userMessage(text: string, i: number, images: string[] = []): ChatMessage {
  const content = images.length === 0
    ? text
    : [
      { type: 'text' as const, text },
      ...images.map((data) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data } })),
    ];
  return { id: `lab-${i}`, messageId: `lab-${i}`, type: 'user', content, timestamp: new Date().toISOString() };
}

/** A sent message carrying notes on the agent's reply, through the real MessageItem. `/lab/annotated-message`. */
export function AnnotatedMessageLab(): JSX.Element {
  const copies = useMemo(() => [markedCopy([120, 330, 1160, 240]), markedCopy([560, 380, 280, 140])], []);
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
        <div className="flex flex-col gap-3">
          <div className="text-[11px] uppercase tracking-wider text-fg-3">two notes on a screenshot, each with its marked copy attached</div>
          <MessageItem message={userMessage(SCREENSHOT_NOTES, FIXTURES.length, copies)} />
        </div>
      </div>
    </div>
  );
}
