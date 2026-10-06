// @vitest-environment happy-dom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../../packages/toolkit/src/components/Composer/Composer.js';

const models = [
  { id: 'gpt-6-astra', label: 'Astra 6', isDefault: true },
  { id: 'gpt-6.1-sol', label: 'Sol 6.1' },
];

afterEach(cleanup);

function show(sessionModel?: string, selectedModel?: string) {
  render(<Composer core={{ onSubmit: vi.fn() }} runtimeConfig={{
    isSessionConnected: true,
    sessionModel,
    selectedModel,
    availableModels: models,
    onModelChange: vi.fn(),
  }} />);
  return screen.getByTestId('session-model');
}

describe('composer model identity', () => {
  it('shows the serving model ahead of the default for new sessions', () => {
    expect(show('gpt-6.1-sol').textContent).toBe('Sol 6.1');
  });

  it('shows an unlisted serving model rather than claiming the default is running', () => {
    expect(show('gpt-next-model').textContent).toBe('gpt-next-model');
  });

  it('shows a pending explicit choice ahead of the serving model', () => {
    expect(show('gpt-6-astra', 'gpt-6.1-sol').textContent).toBe('Sol 6.1');
  });

  it('shows an unlisted explicit choice without reverting to the serving model', () => {
    expect(show('gpt-6-astra', 'gpt-next-model').textContent).toBe('gpt-next-model');
  });

  it('shows the creation default when no session or selection exists', () => {
    expect(show().textContent).toBe('Astra 6');
  });
});
