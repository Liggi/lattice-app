// @vitest-environment happy-dom

/**
 * A message another session sent, in the thread where it was delivered. It
 * must not read as the user's own: its own entry, closed to the sender's name,
 * opening to the message entire.
 *
 * The regression it guards: sessions talking to each other looked as if the
 * user had queued the messages themselves.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { AgentMessage } = await import('../../src/web/chat/components/MessageList/AgentMessage.js');
const { SenderNamesProvider } = await import('../../src/web/chat/components/shared/sender-names.js');

afterEach(cleanup);

describe('AgentMessage', () => {
  it('is closed by default and names the sender, not the message', () => {
    render(<AgentMessage attribution={{ sender: 'conv-abc', passedOn: false }} text="do the thing" />);
    expect(screen.getByTestId('agent-message-summary').textContent).toBe('From conv-abc');
    expect(screen.queryByTestId('agent-message-body')).toBeNull();
    expect(screen.queryByText('do the thing')).toBeNull();
  });

  it('opens to the whole message and closes again', () => {
    const long = 'b'.repeat(4000);
    render(<AgentMessage attribution={{ sender: 'conv-abc', passedOn: false }} text={long} />);
    const summary = screen.getByTestId('agent-message-summary');

    fireEvent.click(summary);
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    // Present character for character; disclosure exposes, it does not clip.
    expect(screen.getByTestId('agent-message-body').textContent).toHaveLength(long.length);

    fireEvent.click(summary);
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('agent-message-body')).toBeNull();
  });

  it('names a worker by the task it was dispatched on', () => {
    render(
      <SenderNamesProvider senders={{ 'conv-abc': { name: 'Keep the queue from covering the conversation', role: 'worker' } }}>
        <AgentMessage attribution={{ sender: 'conv-abc', passedOn: false }} text="do the thing" />
      </SenderNamesProvider>,
    );
    expect(screen.getByTestId('agent-message-summary').textContent)
      .toBe('From the worker on Keep the queue from covering the conversation');
  });

  it('names a coordinator by its outcome, not as a worker', () => {
    render(
      <SenderNamesProvider senders={{ 'conv-front': { name: 'Make the workspace feel right to use', role: 'coordinator' } }}>
        <AgentMessage attribution={{ sender: 'conv-front', passedOn: false }} text="do the thing" />
      </SenderNamesProvider>,
    );
    expect(screen.getByTestId('agent-message-summary').textContent)
      .toBe('From the coordinator for Make the workspace feel right to use');
  });

  it('shows the raw id when the server could not name the sender', () => {
    render(
      <SenderNamesProvider senders={{ 'conv-other': { name: 'Something else', role: 'worker' } }}>
        <AgentMessage attribution={{ sender: 'conv-abc', passedOn: false }} text="do the thing" />
      </SenderNamesProvider>,
    );
    expect(screen.getByTestId('agent-message-summary').textContent).toBe('From conv-abc');
  });

  it('keeps the sender id as identity even when it shows a name', () => {
    render(
      <SenderNamesProvider senders={{ 'conv-abc': { name: 'Run the acceptance', role: 'worker' } }}>
        <AgentMessage attribution={{ sender: 'conv-abc', passedOn: false }} text="ship it" />
      </SenderNamesProvider>,
    );
    expect(screen.getByTestId('agent-message-summary').getAttribute('title')).toBe('conv-abc');
  });

  it('keeps the relayed-decision wording', () => {
    render(
      <SenderNamesProvider senders={{ 'conv-abc': { name: 'Run the acceptance', role: 'worker' } }}>
        <AgentMessage attribution={{ sender: 'conv-abc', passedOn: true }} text="ship it" />
      </SenderNamesProvider>,
    );
    expect(screen.getByTestId('agent-message-summary').textContent)
      .toBe('From the worker on Run the acceptance, relaying your decision');
  });

  it('says a sender that declared nothing is unidentified, never the user', () => {
    render(<AgentMessage attribution={{ sender: null, passedOn: false }} text="who sent this" />);
    expect(screen.getByTestId('agent-message-summary').textContent).toBe('From an unidentified sender');
  });
});
