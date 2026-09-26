// @vitest-environment happy-dom

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ComposerContextControl } from '../../src/web/chat/components/Composer/ComposerContextControl.js';
import { ComposerGoalControl } from '../../src/web/chat/components/Composer/ComposerGoalControl.js';

describe('composer session controls', () => {
  it('opens context details and invokes native compaction', async () => {
    const onCompact = vi.fn(async () => {});
    render(
      <ComposerContextControl
        usage={{
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationInputTokens: 1_000,
          cacheReadInputTokens: 40_000,
          contextTokens: 41_100,
        }}
        compaction={null}
        canCompact
        onCompact={onCompact}
      />,
    );

    const tokenUsage = screen.getByTestId('token-usage');
    expect(tokenUsage.querySelector('[data-tokens]')?.getAttribute('data-tokens')).toBe('41100');
    fireEvent.click(tokenUsage);
    expect(screen.getByRole('dialog', { name: 'Context details' })).toBeTruthy();
    expect(screen.getByText('Uncached input').parentElement?.textContent).toContain('100');
    expect(screen.getByText('Cache read').parentElement?.textContent).toContain('40,000');
    expect(screen.getByText('Cache write').parentElement?.textContent).toContain('1,000');
    expect(screen.getByText('Last output').parentElement?.textContent).toContain('20');

    fireEvent.click(screen.getByTestId('compact-now-button'));
    await waitFor(() => expect(onCompact).toHaveBeenCalledTimes(1));
  });

  it('sets a goal from the reclaimed action slot', async () => {
    const onSave = vi.fn(async () => {});
    render(
      <ComposerGoalControl
        placement="action"
        objective=""
        onSave={onSave}
        onClear={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId('goal-action-button'));
    fireEvent.change(screen.getByLabelText('What should the agent keep working toward?'), {
      target: { value: 'Ship the context controls and verify them' },
    });
    fireEvent.click(screen.getByTestId('goal-save-button'));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith('Ship the context controls and verify them');
    });
  });

  it('shows an active goal as a composer status chip', () => {
    render(
      <ComposerGoalControl
        placement="status"
        objective="Complete the migration"
        status="paused"
        onSave={() => {}}
        onClear={() => {}}
      />,
    );

    expect(screen.getByTestId('goal-status-badge').textContent).toContain('Paused');
  });
});
