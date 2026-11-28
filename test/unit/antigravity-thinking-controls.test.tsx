// @vitest-environment happy-dom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../../packages/toolkit/src/components/Composer/Composer.js';
import {
  ANTIGRAVITY_EFFORT_LABELS,
  ANTIGRAVITY_MODELS,
  DEFAULT_ANTIGRAVITY_PICKER_ID,
  antigravityModelEffort,
  antigravityModelEntry,
  antigravityModelId,
} from '../../src/constants/antigravity-models.js';

afterEach(cleanup);

describe('antigravity model effort helpers', () => {
  it('parses thinking level from full and bare ids', () => {
    expect(antigravityModelEffort('agy:gemini-4-neon-xhigh')).toBe('xhigh');
    expect(antigravityModelEffort('agy:gemini-4-neon-low')).toBe('low');
    expect(antigravityModelEffort('agy:gemini-4-carbon-medium')).toBe('medium');
    expect(antigravityModelEffort('agy:gemini-4-neon')).toBe('high');
    expect(antigravityModelEffort('agy:unknown-model')).toBeNull();
    expect(antigravityModelEffort(null)).toBeNull();
  });

  it('joins picker id and effort, falling back to default when unsupported', () => {
    expect(antigravityModelId('agy:gemini-4-neon', 'xhigh')).toBe('agy:gemini-4-neon-xhigh');
    expect(antigravityModelId('agy:gemini-4-carbon', 'xhigh')).toBe('agy:gemini-4-carbon-high');
    expect(antigravityModelEntry('agy:gemini-4-carbon-low')?.id).toBe('agy:gemini-4-carbon');
  });
});

describe('Composer rail layout per-group reasoning efforts', () => {
  const models = [
    { id: 'claude-default', label: 'Claude Code default', isDefault: true, group: 'Claude' },
    ...ANTIGRAVITY_MODELS.map((m) => ({
      id: m.id,
      label: m.label,
      isDefault: m.id === DEFAULT_ANTIGRAVITY_PICKER_ID,
      group: 'Google',
    })),
  ];

  const defaultGoogleModel = antigravityModelEntry(DEFAULT_ANTIGRAVITY_PICKER_ID)!;
  const googleEfforts = defaultGoogleModel.efforts.map((effortId) => ({
    id: effortId,
    label: ANTIGRAVITY_EFFORT_LABELS[effortId] ?? effortId,
    isDefault: effortId === defaultGoogleModel.defaultEffort,
  }));

  it('shows Google Reasoning options immediately when switching to the Google rail tab from Claude', () => {
    const onEffortChange = vi.fn();
    const onModelChange = vi.fn();

    render(
      <Composer
        core={{ onSubmit: vi.fn() }}
        runtimeConfig={{
          availableModels: models,
          modelMenuLayout: 'rail',
          selectedModel: 'claude-default',
          onModelChange,
          availableEffortsByGroup: { Google: googleEfforts },
          selectedEffort: null,
          onEffortChange,
        }}
      />,
    );

    fireEvent.click(screen.getByTestId('session-model'));
    // Claude tab has no Reasoning controls.
    expect(screen.queryByTestId('effort-option-xhigh')).toBeNull();

    // Switching to Google tab immediately reveals Reasoning controls before picking a model.
    fireEvent.click(screen.getByTestId('model-group-Google'));
    expect(screen.getByTestId('effort-option-low')).toBeTruthy();
    expect(screen.getByTestId('effort-option-medium')).toBeTruthy();
    expect(screen.getByTestId('effort-option-high')).toBeTruthy();
    expect(screen.getByTestId('effort-option-xhigh')).toBeTruthy();
    expect(screen.getByTestId('effort-option-high').getAttribute('aria-checked')).toBe('true');

    // Picking an effort passes the viewed group and keeps the menu open.
    fireEvent.click(screen.getByTestId('effort-option-xhigh'));
    expect(onEffortChange).toHaveBeenCalledWith('xhigh', 'Google');
    expect(screen.getByTestId('model-menu')).toBeTruthy();
  });

  it('allows picking an effort then a model in the Google group and shows non-default effort on the badge', () => {
    const onSubmit = vi.fn();

    function Harness() {
      const [selectedModel, setSelectedModel] = useState<string | null>('claude-default');
      const [selectedEffort, setSelectedEffort] = useState<string | null>(null);
      return (
        <Composer
          core={{ onSubmit }}
          runtimeConfig={{
            availableModels: models,
            modelMenuLayout: 'rail',
            selectedModel,
            onModelChange: (_model, optionId) => {
              setSelectedModel(optionId ?? null);
            },
            availableEffortsByGroup: { Google: googleEfforts },
            selectedEffort,
            onEffortChange: (effort, group) => {
              if (group === 'Google' && !selectedModel?.startsWith('agy:')) {
                setSelectedModel(DEFAULT_ANTIGRAVITY_PICKER_ID);
              }
              setSelectedEffort(effort);
            },
          }}
        />
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByTestId('session-model'));
    fireEvent.click(screen.getByTestId('model-group-Google'));
    fireEvent.click(screen.getByTestId('effort-option-low'));
    expect(screen.getByTestId('session-model').textContent).toContain('Gemini 4 Neon');
    expect(screen.getByTestId('session-model').textContent).toContain('Low');

    // Menu stayed open so the user can pick another Gemini model while keeping Low.
    fireEvent.click(screen.getByTestId('model-option-agy:gemini-4-hydrogen'));
    expect(screen.queryByTestId('model-menu')).toBeNull();
    expect(screen.getByTestId('session-model').textContent).toContain('Gemini 4 Hydrogen');
    expect(screen.getByTestId('session-model').textContent).toContain('Low');
  });
});
