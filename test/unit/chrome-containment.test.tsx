// @vitest-environment happy-dom

/**
 * 22 Nov 2026: the header's plan-usage widget threw on a field the running
 * server did not send yet, the only boundary above it was the App's, and the
 * whole UI went down. Chrome widgets are now contained.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Contained, ErrorBoundary } from '../../src/web/chat/components/ErrorBoundary';

afterEach(cleanup);

function Throws(): JSX.Element {
  throw new Error("Cannot read properties of undefined (reading 'usd')");
}

describe('chrome containment', () => {
  it('a contained widget that throws renders nothing and leaves its siblings', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary name="App" fallback={<p>Application error</p>}>
        <header>
          <Contained name="PlanUsage"><Throws /></Contained>
          <button type="button">Settings</button>
        </header>
      </ErrorBoundary>,
    );
    expect(screen.queryByText('Application error')).toBeNull();
    expect(screen.queryByText(/Render error|Error in/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
  });

  it('fallback={null} means nothing, not the default error card', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(<ErrorBoundary name="link" fallback={null}><Throws /></ErrorBoundary>);
    expect(container.innerHTML).toBe('');
  });
});
