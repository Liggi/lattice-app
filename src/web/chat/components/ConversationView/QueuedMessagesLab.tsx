import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { QueuedMessages } from './QueuedMessages';
import type { PendingInput } from '../../hooks/useHarnessSession';

// ============================================================
// Fixture data only. No session is read or written by this page.
// ============================================================

let seq = 0;

function fixture(text: string, sender?: string, undeliverable?: string): PendingInput {
  seq += 1;
  return {
    inputEvent: {
      sessionId: 'lab-fixture',
      runId: 'lab-fixture',
      seq,
      type: 'input:sent',
      timestamp: Date.now(),
      data: {},
    } as PendingInput['inputEvent'],
    text,
    undeliverable: undeliverable ?? null,
    ...(sender ? { attribution: { sender, passedOn: false } } : {}),
  };
}

const LONG = `The acceptance you asked for is not what I ran. I checked the drain path on a live session instead of the hydration path, so the result says nothing about what happens when the page is reloaded mid-turn.

Two things follow from that:

1. The claim that queued messages survive a reload is unverified. I would not put it in the release note yet.
2. The test I added covers the drain only. It passes, but it would pass with the hydration bug present.

I can run the reload case next, or leave it and say plainly in the report that it is untested. Tell me which you want and I will do it before the trial restart, because after the restart the armed runner takes the checkout and I would be verifying a different build.`;

const SCENARIOS: Array<{ id: string; label: string; messages: PendingInput[] }> = [
  { id: 'none', label: 'Nothing queued', messages: [] },
  { id: 'mine', label: 'One message of yours', messages: [fixture('Use PEACH as the code word from now on.')] },
  { id: 'one', label: 'One queued message', messages: [fixture('Hold off on the restart until the search worker reports.', 'front')] },
  {
    id: 'many',
    label: 'Eight queued messages',
    messages: [
      fixture('Hold off on the restart until the search worker reports.', 'front'),
      fixture('Also check the phone width before you commit.', 'front'),
      fixture('The user says the queue is covering the conversation — that is your thread now.', 'front'),
      fixture('Ignore the previous message if you already started on it.'),
      fixture('The release branch moved; rebase before you run the typecheck.', 'front'),
      fixture('One more: keep the fixture sessions archived at creation.', 'front'),
      fixture('Reply when you reach a turn boundary.', 'front', 'the session was not accepting input'),
      fixture('Last one — screenshot both widths, not just desktop.', 'front'),
    ],
  },
  { id: 'long', label: 'One very long queued message', messages: [fixture(LONG, 'front')] },
  {
    id: 'long-many',
    label: 'Three long queued messages',
    messages: [fixture(LONG, 'front'), fixture(LONG), fixture(LONG, 'a worker')],
  },
];

/**
 * Renders the queue above a stand-in composer at the height it really gets,
 * so the space it takes from the conversation is visible. `/lab/queued-messages`.
 */
export function QueuedMessagesLab(): JSX.Element {
  const [scenario, setScenario] = useState(SCENARIOS[3]);
  return (
    <div className="h-full w-full flex flex-col bg-bg text-fg">
      <div className="flex-shrink-0 flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <Link to="/" className="text-xs text-fg-3 hover:text-fg">Back</Link>
        <span className="text-xs text-fg-3">Sample data — no real session</span>
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setScenario(s)}
            className={`rounded-md px-2 py-1 text-xs ${s.id === scenario.id ? 'bg-surface text-fg' : 'text-fg-3 hover:text-fg'}`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        <div className="mx-auto w-full max-w-3xl space-y-4">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="text-sm leading-[1.55] text-fg-2">
              This line stands in for the conversation. If the queue is doing its job you can still
              read what the session is actually working on, at every width.
            </div>
          ))}
        </div>
      </div>
      <div className="flex-shrink-0 bg-bg z-10 w-full flex flex-col items-center pt-3 pb-3">
        <QueuedMessages messages={scenario.messages} />
        <div className="w-full max-w-3xl px-4">
          <div className="rounded-lg border border-line px-3.5 py-2.5 text-sm text-fg-3">Reply</div>
        </div>
      </div>
    </div>
  );
}
