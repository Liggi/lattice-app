// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlanUsageMenuRow, planUsageAlert } from '../../src/web/chat/components/ConversationHeader/PlanUsageControl';

const NOW = Date.parse('2026-11-25T20:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Claude at 50% / 28% two days before its reset (pace 71%: lasting). */
const claude = {
  state: 'ok' as const,
  checkedAt: NOW,
  limits: [
    { window: 'week' as const, scope: 'all models', percentUsed: 50, resets: 'Nov 27 at 8pm' },
    { window: 'week' as const, scope: 'Fable', percentUsed: 28, resets: 'Nov 27 at 8pm' },
  ],
};
const spend = { today: { usd: 0, countedTurns: 0, uncountedTurns: 0 }, last7Days: { usd: 1000, countedTurns: 1, uncountedTurns: 0 }, budget: { usd: 1402, countedTurns: 1, uncountedTurns: 0, limitUsd: 500, days: 30 } };

function gemini(weekly: number, fiveHour: number, fiveHourResetIn = 4 * HOUR, others = 0, weeklyResetIn = 6 * DAY) {
  return {
    state: 'ok' as const,
    checkedAt: NOW,
    limits: [
      { id: 'gemini-weekly', group: 'Gemini Models', window: 'week' as const, percentUsed: weekly, resetAt: NOW + weeklyResetIn },
      { id: 'gemini-5h', group: 'Gemini Models', window: '5h' as const, percentUsed: fiveHour, resetAt: NOW + fiveHourResetIn },
      { id: '3p-weekly', group: 'Claude and GPT models', window: 'week' as const, percentUsed: others, resetAt: others ? NOW + 6 * DAY : null },
      { id: '3p-5h', group: 'Claude and GPT models', window: '5h' as const, percentUsed: 0, resetAt: null },
    ],
  };
}

async function renderPanel(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PlanUsageMenuRow open onToggle={() => {}} className="flex" />
    </QueryClientProvider>,
  );
  return screen.findByTestId('plan-usage');
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Gemini plan in the usage display', () => {
  it('a healthy Gemini plan raises no alert, though the old API estimate is far over $500', () => {
    expect(planUsageAlert({ claude, gemini: spend, geminiMode: 'plan', geminiPlan: gemini(3, 13) })).toBeNull();
    expect(planUsageAlert({ claude, gemini: spend })).toBe('rose');
  });

  it('a 5-hour limit pacing to run out within half an hour is rose; later before the reset is amber', () => {
    // An hour into the 5-hour window (20% gone): 80% used runs out 15 minutes from now.
    expect(planUsageAlert({ claude, gemini: spend, geminiMode: 'plan', geminiPlan: gemini(3, 80) })).toBe('rose');
    // 30% used runs out at 67% of the window, two and a third hours from now.
    expect(planUsageAlert({ claude, gemini: spend, geminiMode: 'plan', geminiPlan: gemini(3, 30) })).toBe('amber');
  });

  it('an unreadable Gemini plan adds no tone of its own', () => {
    expect(planUsageAlert({ claude, gemini: spend, geminiMode: 'plan', geminiPlan: { state: 'unavailable', reason: 'x', checkedAt: NOW } })).toBeNull();
  });

  it('shows the weekly and 5-hour limits and hides an unused model group', async () => {
    const row = await renderPanel({ claude, gemini: spend, geminiMode: 'plan', geminiPlan: gemini(3, 13) });
    expect(row.getAttribute('aria-label')).toContain('Gemini weekly 3% used, 5-hour 13% used');
    expect(screen.getByText('Gemini plan')).toBeTruthy();
    expect(screen.getAllByText('Lasts until the reset')).toHaveLength(2);
    expect(screen.getByText('Weekly')).toBeTruthy();
    expect(screen.getByText('5-hour')).toBeTruthy();
    expect(screen.queryByText('Claude, GPT')).toBeNull();
    expect(screen.queryByText('Gemini API')).toBeNull();
  });

  it('does not judge pace before a tenth of the window has gone', async () => {
    // Five hours into the week (3% gone) with 3% used: a straight-line pace would run out an hour before the reset.
    await renderPanel({ claude, gemini: spend, geminiMode: 'plan', geminiPlan: gemini(3, 13, 55 * 60_000, 0, 7 * DAY - 5 * HOUR + 10 * 60_000) });
    expect(screen.getAllByText('Lasts until the reset')).toHaveLength(2);
  });

  it('names the 5-hour limit when it runs out first, and lists a model group once used', async () => {
    await renderPanel({ claude, gemini: spend, geminiMode: 'plan', geminiPlan: gemini(3, 30, 4 * HOUR, 12) });
    expect(screen.getByText(/^5-hour limit runs out \d{1,2}(:\d{2})?[ap]m, back at \d{1,2}(:\d{2})?[ap]m$/)).toBeTruthy();
    expect(screen.getByText('Claude, GPT')).toBeTruthy();
    expect(screen.getByText('12%')).toBeTruthy();
  });

  it('marks an unreadable plan instead of falling back to the API budget', async () => {
    const row = await renderPanel({ claude, gemini: spend, geminiMode: 'plan', geminiPlan: { state: 'unavailable', reason: 'agy is not signed in', checkedAt: NOW } });
    expect(row.getAttribute('aria-label')).toContain('Gemini plan unreadable');
    expect(screen.getByText("Couldn't read the plan: agy is not signed in")).toBeTruthy();
  });

  it('keeps the API spend view when a Cloud project is billed', async () => {
    await renderPanel({ claude, gemini: spend, geminiMode: 'api' });
    expect(screen.getByText('Gemini API')).toBeTruthy();
    expect(screen.queryByText('Gemini plan')).toBeNull();
  });
});
