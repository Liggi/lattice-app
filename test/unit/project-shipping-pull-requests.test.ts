import { describe, expect, it } from 'vitest';
import { failingCheckNames, pullRequests, type PullRequestReader } from '../../src/services/sessions/project-shipping';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const HOUR = 60 * 60_000;

function pull(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `PR ${number}`,
    author: { login: 'me' },
    state: 'OPEN' as const,
    isDraft: false,
    mergedAt: null,
    closedAt: null,
    updatedAt: new Date(NOW - HOUR).toISOString(),
    url: `https://github.com/o/r/pull/${number}`,
    mergeCommit: null,
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    ...overrides,
  };
}

function reader(list: ReturnType<typeof pull>[], options: {
  views?: Record<number, ReturnType<typeof pull> | Error>;
  checks?: Record<number, { reviewDecision: string | null; statusCheckRollup: Array<Record<string, string>> } | Error>;
} = {}) {
  const calls = { list: 0, view: [] as number[], checks: [] as number[] };
  const fake: PullRequestReader = {
    list: async () => { calls.list += 1; return list; },
    view: async (_github, number) => {
      calls.view.push(number);
      const found = options.views?.[number];
      if (!found) throw new Error(`GraphQL: Could not resolve to a PullRequest with the number of ${number}.`);
      if (found instanceof Error) throw found;
      return found;
    },
    checks: async (_github, number) => {
      calls.checks.push(number);
      const found = options.checks?.[number] ?? { reviewDecision: null, statusCheckRollup: [] };
      if (found instanceof Error) throw found;
      return found;
    },
  };
  return { fake, calls };
}

describe('pullRequests', () => {
  it('reads checks only for the open pull requests it shows, one at a time', async () => {
    const { fake, calls } = reader(
      [pull(1), pull(2), pull(3, { author: { login: 'colleague' } }), pull(4, { isDraft: true })],
      { checks: { 1: { reviewDecision: 'APPROVED', statusCheckRollup: [{ conclusion: 'SUCCESS' }] }, 2: { reviewDecision: null, statusCheckRollup: [{ conclusion: 'FAILURE' }] } } },
    );
    const found = await pullRequests('o/r', new Set([1, 2, 3, 4]), 'me', NOW, fake);
    expect(calls.checks.sort()).toEqual([1, 2]);
    expect(found.items.map((item) => `${item.key}:${item.stage}`).sort()).toEqual([
      'o/r#1:approved',
      'o/r#2:checks-failing',
      'o/r#4:draft',
    ]);
    expect(found.unread).toEqual([]);
  });

  it('names the failing checks from the rollup it already read, check runs and status contexts alike', async () => {
    const { fake, calls } = reader([pull(2)], { checks: { 2: { reviewDecision: null, statusCheckRollup: [
      { name: 'typecheck', conclusion: 'FAILURE', status: 'COMPLETED' },
      { name: 'lint', conclusion: 'SUCCESS', status: 'COMPLETED' },
      { context: 'ci/circleci: e2e', state: 'ERROR' },
    ] } } });
    const found = await pullRequests('o/r', new Set([2]), 'me', NOW, fake);
    expect(calls.checks).toEqual([2]);
    expect(found.items).toEqual([expect.objectContaining({ key: 'o/r#2', stage: 'checks-failing', failedChecks: ['typecheck', 'ci/circleci: e2e'] })]);
  });

  it('looks up a mentioned pull request missing from the recent list, and skips numbers that are not pull requests', async () => {
    const { fake, calls } = reader([pull(10)], { views: { 7: pull(7) } });
    const found = await pullRequests('o/r2', new Set([7, 8, 10]), 'me', NOW, fake);
    expect(calls.view.sort()).toEqual([7, 8]);
    expect(found.items.map((item) => item.key).sort()).toEqual(['o/r2#10', 'o/r2#7']);
    expect(found.unread).toEqual([]);
  });

  it('puts a failed check read in unread and does not guess the stage', async () => {
    const { fake } = reader([pull(5)], { checks: { 5: new Error('HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)') } });
    const found = await pullRequests('o/r3', new Set([5]), 'me', NOW, fake);
    expect(found.items).toEqual([expect.objectContaining({ key: 'o/r3#5', stage: 'checks-running', stageLabel: 'Open, checks not read' })]);
    expect(found.unread).toEqual(['checks on o/r3 #5: HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)']);
  });

  it('puts a failed lookup of a missing pull request in unread', async () => {
    const { fake } = reader([], { views: { 9: new Error('HTTP 502: Bad Gateway') } });
    const found = await pullRequests('o/r4', new Set([9]), 'me', NOW, fake);
    expect(found.items).toEqual([]);
    expect(found.unread).toEqual(['o/r4 #9: HTTP 502: Bad Gateway']);
  });

  it('drops pull requests closed over a day ago and keeps one closed today', async () => {
    const { fake } = reader([
      pull(20, { state: 'CLOSED', closedAt: new Date(NOW - 2 * HOUR).toISOString() }),
      pull(21, { state: 'CLOSED', closedAt: new Date(NOW - 30 * HOUR).toISOString() }),
    ]);
    const found = await pullRequests('o/r5', new Set([20, 21]), 'me', NOW, fake);
    expect(found.items.map((item) => `${item.key}:${item.stage}`)).toEqual(['o/r5#20:closed']);
  });
});

describe('failingCheckNames', () => {
  it('keeps each failing name once, skips unnamed and passing checks, and stops at six', () => {
    const failing = (name: string) => ({ name, conclusion: 'FAILURE' });
    expect(failingCheckNames([
      failing('a'), failing('a'), { conclusion: 'TIMED_OUT' }, { name: 'ok', conclusion: 'SUCCESS' },
      failing('b'), failing('c'), failing('d'), failing('e'), failing('f'), failing('g'),
    ])).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});
