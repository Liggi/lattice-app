// @vitest-environment happy-dom

/**
 * The report card. The user reads a thread of these to follow what their agents
 * did, so the card leads with a result line and a few sentences and keeps the
 * report itself one click away.
 *
 * What is guarded here is that the summary never replaces the report: the
 * report is what the coordinator acted on and what the user checks the summary
 * against, so it has to still be there, whole, and the card has to still say
 * the words came from the worker. And that a report with no summary — every
 * report before 2026-09-21, and any written while the gate is closed — renders
 * exactly as it did before rather than as an empty card.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessage } from '../../src/web/chat/types/index.js';

const { WorkerEventBlock } = await import('../../src/web/chat/components/WorkerEvents/WorkerEventBlock.js');

const REPORT = [
  'Header and sidebar simplified.',
  '',
  'The Catch me up button and the commitments chip are gone.',
  '',
  'The backend removal is written but the routes are still registered until the server restarts.',
].join('\n');

const SUMMARY = {
  worker: 'conv-w',
  reportSeq: 41,
  title: 'Header and sidebar simplified',
  text: [
    'The requested controls are removed.',
    'Desktop and mobile were checked in the running app.',
    'The interface changes are live now through the dev server.',
    'Fully removing the commitments backend still needs a restart.',
  ].join('\n'),
  model: 'claude-sonnet-5',
};

function reported(reportSummary?: typeof SUMMARY): ChatMessage {
  return {
    id: 'h-41',
    messageId: 'h-41',
    type: 'system',
    content: '',
    timestamp: '2026-09-21T10:00:00.000Z',
    systemSubtype: 'worker',
    workerEvent: {
      type: 'worker:reported',
      data: { worker: 'conv-w', model: 'claude-opus-5', text: REPORT },
      ...(reportSummary ? { reportSummary } : {}),
    },
  } as ChatMessage;
}

afterEach(cleanup);

describe('a report card with a summary', () => {
  it('leads with the result and the facts, and holds the report behind Full report', () => {
    render(<WorkerEventBlock message={reported(SUMMARY)} />);
    expect(screen.getByTestId('worker-report-summary').textContent).toContain('Header and sidebar simplified');
    expect(screen.getByTestId('worker-report-summary').textContent).toContain('still needs a restart');
    expect(screen.queryByTestId('worker-report-body')).toBeNull();

    fireEvent.click(screen.getByText('Full report'));
    expect(screen.getByTestId('worker-report-body').textContent).toContain('the routes are still registered');
  });

  it('gives each fact its own line rather than running them into a paragraph', () => {
    render(<WorkerEventBlock message={reported(SUMMARY)} />);
    const lines = [...screen.getByTestId('worker-report-summary').querySelectorAll('li')];
    expect(lines.map((line) => line.textContent)).toEqual([
      'The requested controls are removed.',
      'Desktop and mobile were checked in the running app.',
      'The interface changes are live now through the dev server.',
      'Fully removing the commitments backend still needs a restart.',
    ]);
  });

  it('writes a lone fact as a plain line, which is also what a summary written as a paragraph gets', () => {
    render(<WorkerEventBlock message={reported({ ...SUMMARY, text: 'Nothing was changed; this is an assessment only.' })} />);
    const summary = screen.getByTestId('worker-report-summary');
    expect(summary.querySelectorAll('li')).toHaveLength(0);
    expect(summary.textContent).toContain('Nothing was changed; this is an assessment only.');
  });

  it('shows the report whole, not clipped, and keeps the summary above it', () => {
    render(<WorkerEventBlock message={reported(SUMMARY)} />);
    fireEvent.click(screen.getByText('Full report'));
    const body = screen.getByTestId('worker-report-body');
    expect(body.getAttribute('style')).toBeNull();
    expect(body.textContent).toContain('The Catch me up button and the commitments chip are gone.');
    expect(screen.getByTestId('worker-report-summary')).toBeTruthy();

    fireEvent.click(screen.getByText('Show less'));
    expect(screen.queryByTestId('worker-report-body')).toBeNull();
  });

  it('still attributes the words to the worker', () => {
    render(<WorkerEventBlock message={reported(SUMMARY)} />);
    expect(screen.getByTestId('worker-reported').textContent).toContain('Reported');
  });

  it('opens the worker session from the card', () => {
    const onNavigateToSession = vi.fn();
    render(<WorkerEventBlock message={reported(SUMMARY)} onNavigateToSession={onNavigateToSession} />);
    fireEvent.click(screen.getByText('Open agent session'));
    expect(onNavigateToSession).toHaveBeenCalledWith('conv-w');
  });
});

describe('a report card with no summary', () => {
  it('shows the report itself, clipped, as it did before', () => {
    render(<WorkerEventBlock message={reported()} />);
    expect(screen.queryByTestId('worker-report-summary')).toBeNull();
    const body = screen.getByTestId('worker-report-body');
    expect(body.textContent).toContain('The Catch me up button and the commitments chip are gone.');
    expect(body.getAttribute('style')).toContain('max-height');
  });

  it('says nothing about a summary being missing', () => {
    render(<WorkerEventBlock message={reported()} />);
    expect(screen.getByTestId('worker-reported').textContent).not.toMatch(/summary/i);
  });
});
