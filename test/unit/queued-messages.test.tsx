// @vitest-environment happy-dom

/**
 * Messages a session has not taken in yet sit faded above its composer, as
 * the old Lattice showed them: no summary line saying
 * when they will be read, only the messages. Another agent's message keeps
 * its closed one-line entry, because a coordinator's backlog once covered the
 * whole phone viewport (2026-09-21).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { QueuedMessages } = await import(
  '../../src/web/chat/components/ConversationView/QueuedMessages.js'
);

type Queued = Parameters<typeof QueuedMessages>[0]['messages'][number];

function queued(seq: number, text: string, extra: Partial<Queued> = {}): Queued {
  return {
    inputEvent: { sessionId: 's', runId: 'r', seq, type: 'input:sent', timestamp: seq, data: {} },
    text,
    undeliverable: null,
    ...extra,
  } as Queued;
}

afterEach(cleanup);

describe('QueuedMessages', () => {
  it('renders nothing when nothing is pending', () => {
    const { container } = render(<QueuedMessages messages={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows each message faded, in full and in order, with no word about when it will be read', () => {
    const long = 'a'.repeat(4000);
    render(<QueuedMessages messages={[queued(1, 'first'), queued(2, long)]} />);

    const entries = screen.getAllByTestId('pending-message');
    expect(entries.map(e => e.textContent?.slice(0, 5))).toEqual(['first', 'aaaaa']);
    expect(entries[1].textContent).toHaveLength(long.length);
    expect(entries[0].querySelector('.opacity-60')).not.toBeNull();
    const all = screen.getByTestId('queued-messages').textContent ?? '';
    expect(all).not.toMatch(/waiting|turn|queued/i);
  });

  it('shows a message with notes as passage and note, as the thread does once it is sent', () => {
    const text = '[Notes on your earlier output]\n1. Re: "a passage"\n   Note: why this?\n[/Notes]\n\nand the rest';
    render(<QueuedMessages messages={[queued(1, text)]} />);
    expect(screen.getByTestId('annotated-quote').textContent).toBe('a passage');
    expect(screen.getByTestId('annotated-message').textContent).toContain('why this?');
    expect(screen.getByTestId('pending-message').textContent).not.toContain('[Notes');
  });

  it('keeps another agent’s message to its closed entry, attributed', () => {
    render(<QueuedMessages messages={[queued(1, 'hold the restart', { attribution: { sender: 'front', passedOn: false } })]} />);
    expect(screen.getByTestId('message-attribution').textContent).toBe('From front');
    expect(screen.queryByText('hold the restart')).toBeNull();
  });

  it('says why a message could not be handed over, and only for that one', () => {
    render(
      <QueuedMessages
        messages={[queued(1, 'first'), queued(2, 'second', { undeliverable: 'the session was not accepting input' })]}
      />,
    );
    const notes = screen.getAllByTestId('pending-message-delivery');
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toContain('the session was not accepting input');
  });
});
