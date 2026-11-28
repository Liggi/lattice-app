// @vitest-environment happy-dom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../../packages/toolkit/src/components/Composer/Composer.js';

afterEach(cleanup);

const CLAUDE_EFFORTS = [
  { id: 'default', label: 'Default', isDefault: true },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'max', label: 'Max' },
];

const OPENAI_EFFORTS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high', isDefault: true },
  { id: 'max', label: 'Max' },
];

const MODELS = [
  { id: 'claude-fable-5-2', label: 'Fable 5.2', group: 'Claude', efforts: ['default', 'low', 'medium', 'high', 'max'], defaultEffort: 'default' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', isDefault: true, group: 'Claude', efforts: ['default', 'low', 'medium', 'high', 'max'], defaultEffort: 'default' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', group: 'Claude', efforts: ['default'], defaultEffort: 'default' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', other: true, group: 'Claude', efforts: ['default', 'low', 'medium', 'high', 'max'], defaultEffort: 'default' },
  { id: 'gpt-6-astra', label: 'Astra 6', isDefault: true, group: 'OpenAI', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'xhigh' },
  { id: 'gpt-6.1-sol', label: 'Sol 6.1', group: 'OpenAI', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'xhigh' },
];

describe('ModelEffortPad in Composer rail menu', () => {
  it('renders the 2D pad for providers with per-model efforts and commits atomically', () => {
    const onModelAndEffortChange = vi.fn();

    render(
      <Composer
        core={{ onSubmit: vi.fn() }}
        runtimeConfig={{
          availableModels: MODELS,
          availableEffortsByGroup: { Claude: CLAUDE_EFFORTS, OpenAI: OPENAI_EFFORTS },
          modelMenuLayout: 'rail',
          selectedModel: 'claude-opus-5-5',
          selectedEffort: null,
          onModelChange: vi.fn(),
          onModelAndEffortChange,
        }}
      />,
    );

    fireEvent.click(screen.getByTestId('session-model'));
    expect(screen.getByTestId('model-effort-pad')).toBeTruthy();
    expect(screen.getByTestId('matrix-active-model').textContent).toBe('Opus 5.5');
    expect(screen.getByTestId('matrix-active-effort').textContent).toBe('Default');

    // Keyboard navigation: move up to Fable 5.2, right to Low, and commit with Enter.
    const pad = screen.getByTestId('matrix-pad-surface');
    fireEvent.keyDown(pad, { key: 'ArrowUp' });
    fireEvent.keyDown(pad, { key: 'ArrowRight' });
    expect(screen.getByTestId('matrix-active-model').textContent).toBe('Fable 5.2');
    expect(screen.getByTestId('matrix-active-effort').textContent).toBe('Low');

    fireEvent.keyDown(pad, { key: 'Enter' });
    expect(onModelAndEffortChange).toHaveBeenCalledWith('claude-fable-5-2', 'low', {
      optionId: 'claude-fable-5-2',
      group: 'Claude',
    });
  });

  it('clamps effort to nearest supported column on ragged rows (Haiku supports only Default)', () => {
    const onModelAndEffortChange = vi.fn();

    render(
      <Composer
        core={{ onSubmit: vi.fn() }}
        runtimeConfig={{
          availableModels: MODELS,
          availableEffortsByGroup: { Claude: CLAUDE_EFFORTS, OpenAI: OPENAI_EFFORTS },
          modelMenuLayout: 'rail',
          selectedModel: 'claude-opus-5-5',
          selectedEffort: 'max',
          onModelChange: vi.fn(),
          onModelAndEffortChange,
        }}
      />,
    );

    fireEvent.click(screen.getByTestId('session-model'));
    const pad = screen.getByTestId('matrix-pad-surface');
    // Move down from Opus 5.5 (row 1, col Max) to Haiku 5.5 (row 2, only Default supported).
    fireEvent.keyDown(pad, { key: 'ArrowDown' });
    expect(screen.getByTestId('matrix-active-model').textContent).toBe('Haiku 5.5');
    expect(screen.getByTestId('matrix-active-effort').textContent).toBe('Default');

    // Moving back up restores desired column Max.
    fireEvent.keyDown(pad, { key: 'ArrowUp' });
    expect(screen.getByTestId('matrix-active-model').textContent).toBe('Opus 5.5');
    expect(screen.getByTestId('matrix-active-effort').textContent).toBe('Max');
  });

  it('marks inactive provider tabs honestly at rest and reveals Older models on toggle', () => {
    render(
      <Composer
        core={{ onSubmit: vi.fn() }}
        runtimeConfig={{
          availableModels: MODELS,
          availableEffortsByGroup: { Claude: CLAUDE_EFFORTS, OpenAI: OPENAI_EFFORTS },
          modelMenuLayout: 'rail',
          selectedModel: 'claude-opus-5-5',
          selectedEffort: null,
          onModelChange: vi.fn(),
          onModelAndEffortChange: vi.fn(),
        }}
      />,
    );

    fireEvent.click(screen.getByTestId('session-model'));
    expect(screen.queryByTestId('model-option-claude-fable-5-1')).toBeNull();
    fireEvent.click(screen.getByTestId('model-menu-other'));
    expect(screen.getByTestId('model-option-claude-fable-5-1')).toBeTruthy();

    // Switch to inactive OpenAI tab: no active glowing orb at rest.
    fireEvent.click(screen.getByTestId('model-group-OpenAI'));
    expect(screen.getByTestId('model-effort-pad').getAttribute('data-active-group')).toBe('false');
    expect(screen.queryByTestId('matrix-active-orb')).toBeNull();
  });
});
