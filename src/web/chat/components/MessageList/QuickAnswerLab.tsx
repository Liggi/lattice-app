import React from 'react';
import { Link } from 'react-router-dom';
import { MessageItem } from './MessageItem';
import type { ChatMessage, QuickAnswerDelivery } from '../../types';

// ============================================================
// Fixture data only. No session is read or written by this page.
// ============================================================

const ANSWER = `The worker fixing the export button reported about ten minutes ago: the fix is in and its tests pass, but it hasn't been tried in a browser yet. The coordinator hasn't read that report, because it is still partway through a turn on the settings page.

Next: when that turn ends, the coordinator reads the report and decides whether to send someone to check it in a browser. Nothing is waiting on you right now.`;

function ask(text: string): ChatMessage {
  return {
    id: 'lab-ask',
    messageId: 'lab-ask',
    type: 'user',
    content: text,
    timestamp: new Date().toISOString(),
  };
}

function quickAnswer(delivery: QuickAnswerDelivery): ChatMessage {
  return {
    id: `lab-answer-${delivery}`,
    messageId: `lab-answer-${delivery}`,
    type: 'assistant',
    content: [{ type: 'text', text: ANSWER }],
    timestamp: new Date().toISOString(),
    responder: 'fast',
    responderDelivery: delivery,
  };
}

const CASES: ReadonlyArray<{ delivery: QuickAnswerDelivery; caption: string }> = [
  { delivery: 'waiting', caption: 'the answer is loaded and no receipt names its row' },
  { delivery: 'seen', caption: 'input:read named the answer\'s row' },
  { delivery: 'unknown', caption: 'scrolled past the row: the window cannot say either way' },
];

/**
 * The quick-answer card in both states it can be in: waiting, and handed to a
 * turn. The two are one line apart on purpose — the card is an aside, and the
 * delivery line has to be readable without competing with the answer.
 * `/lab/quick-answer`.
 */
export function QuickAnswerLab(): JSX.Element {
  return (
    <div className="h-full w-full overflow-y-auto bg-bg text-fg">
      <div className="mx-auto max-w-3xl px-6 py-8 flex flex-col gap-8">
        <div className="flex items-baseline gap-3">
          <h1 className="text-sm uppercase tracking-wider text-fg-2">Quick answer</h1>
          <Link to="/" className="text-xs text-cyan-400">back to app</Link>
        </div>
        {CASES.map(({ delivery, caption }) => (
          <div key={delivery} className="flex flex-col gap-3">
            <div className="text-[11px] uppercase tracking-wider text-fg-3">{caption}</div>
            <div className="rounded-lg border border-line/60 p-4 flex flex-col gap-3">
              <MessageItem message={ask('where are we with the export button?')} />
              <MessageItem message={quickAnswer(delivery)} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
