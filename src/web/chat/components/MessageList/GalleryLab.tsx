import React, { type JSX, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageItem } from './MessageItem';
import type { ChatMessage } from '../../types';
import type { PendingAnnotation } from '../../utils/annotations-format';
import { ImageNotesContext, type ImageNotesApi } from './image-notes-context';

// ============================================================
// Fixture data only. No session is read or written by this page. The images
// are local files (`?dir=` overrides the folder); a missing one shows broken.
// ============================================================

const DIR = new URLSearchParams(typeof location !== 'undefined' ? location.search : '').get('dir') ?? '/tmp/gallery-scope/fixture';

const BLOCK = JSON.stringify({
  images: [
    {
      path: `${DIR}/step3-desktop.png`,
      size: [2880, 3030],
      caption: 'Step 3: your PR\'s guardrail page reviewing the added line',
      notes: [{ text: 'This is the line the PR adds; nothing else on the page changes.' }],
    },
    {
      path: `${DIR}/step4-desktop.png`,
      size: [2880, 4046],
      caption: 'Step 4: proposed replay result before Put live',
      notes: [
        { text: 'The replay count: 23 of 200 past turns use the metaphor now, 2 with the fix.', box: [729, 1608, 1589, 131] },
        { text: 'Put live stays the last step, after the pairs above.', box: [2203, 2540, 156, 86] },
      ],
    },
  ],
}, null, 2);

const MESSAGE: ChatMessage = {
  id: 'gallery-lab',
  messageId: 'gallery-lab',
  type: 'assistant',
  content: `Here are the two steps with my notes on them.\n\n\`\`\`lattice-gallery\n${BLOCK}\n\`\`\``,
  timestamp: new Date().toISOString(),
};

const SEEDED: PendingAnnotation[] = [{
  id: 'lab-you-1',
  messageId: 'gallery-lab',
  quote: 'Step 4: proposed replay result before Put live',
  note: "This reply still says the edge; the fix needs to cover 'feels close' too.",
  createdAt: 1,
  image: { src: `/api/images?path=${encodeURIComponent(`${DIR}/step4-desktop.png`)}`, path: `${DIR}/step4-desktop.png`, box: { x: 1521 / 2880, y: 1778 / 4046, w: 794 / 2880, h: 162 / 4046 } },
}];

/** An agent message with a ```lattice-gallery block, and notes of yours kept in memory. `/lab/gallery`. */
export function GalleryLab(): JSX.Element {
  const [notes, setNotes] = useState<PendingAnnotation[]>(SEEDED);
  const api = useMemo<ImageNotesApi>(() => ({
    notes,
    add: ({ messageId, src, path, label, box, note }) => setNotes((all) => [...all, {
      id: `lab-${Date.now()}`, messageId, quote: label, note, createdAt: Date.now(), image: { src, ...(path ? { path } : {}), box },
    }]),
    update: (id, note) => setNotes((all) => all.map((n) => (n.id === id ? { ...n, note } : n))),
    remove: (id) => setNotes((all) => all.filter((n) => n.id !== id)),
  }), [notes]);
  return (
    <div className="h-full w-full overflow-y-auto bg-bg text-fg">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6 flex flex-col gap-6">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[11px] uppercase tracking-wider text-fg-2">Agent notes on screenshots</h1>
          <Link to="/" className="text-xs text-accent">back to app</Link>
        </div>
        <ImageNotesContext.Provider value={api}>
          {/* The thread marks each message so the viewer can find its series and notes. */}
          <div data-message-id={MESSAGE.messageId}>
            <MessageItem message={MESSAGE} />
          </div>
        </ImageNotesContext.Provider>
      </div>
    </div>
  );
}
