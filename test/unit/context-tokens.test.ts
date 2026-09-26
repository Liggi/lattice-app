import { describe, expect, it } from 'vitest';
import { contextTokensOf, formatContextTokens } from '../../src/session-history/context-tokens.js';
import { compactedSinceLastInput } from '../../src/services/sessions/context-compaction.js';
import { CONTEXT_RESTORE_END, CONTEXT_RESTORE_PREFIX, isWorkerInput, stripContextRestore, stripPreamble } from '../../src/types/worker-events.js';
import { buildCoordinatorPreamble, buildWorkerPreamble } from '../../src/services/sessions/pickup-prompts.js';

const claudeCall = (tokens: number) => ({ type: 'content', data: { blocks: [], apiUsage: { input_tokens: tokens - 1000, cache_creation_input_tokens: 400, cache_read_input_tokens: 600 } } });
// Codex turn:end usage follows the harness split: input is the uncached remainder.
const codexTurn = (tokens: number) => ({ type: 'turn:end', data: { usage: { input_tokens: 500, cache_read_input_tokens: tokens - 500 } } });
const boundary = (postTokens?: number) => ({ type: 'turn:end', data: { compact: true, trigger: 'auto', ...(postTokens === undefined ? {} : { postTokens }) } });

describe('contextTokensOf', () => {
  it('reads the newest Claude per-call usage', () => {
    expect(contextTokensOf([claudeCall(50_000), claudeCall(120_000)], 'claude')).toBe(120_000);
  });
  it('reads the newest Codex per-turn usage', () => {
    expect(contextTokensOf([codexTurn(60_000), codexTurn(134_000)], 'codex')).toBe(134_000);
  });
  it('trusts a Claude compaction boundary and reports unknown after a Codex one', () => {
    expect(contextTokensOf([claudeCall(167_000), boundary(16_000)], 'claude')).toBe(16_000);
    expect(contextTokensOf([codexTurn(134_000), boundary()], 'codex')).toBeNull();
  });

  it('skips a Codex turn that reports zero usage (interrupted, blocked, or the compaction turn itself)', () => {
    const zeroTurn = { type: 'turn:end', data: { usage: { input_tokens: 0, cache_read_input_tokens: 0 } } };
    expect(contextTokensOf([codexTurn(134_000), zeroTurn], 'codex')).toBe(134_000);
  });
  it('is null with no measurement', () => {
    expect(contextTokensOf([{ type: 'input:sent', data: { text: 'hi' } }], 'claude')).toBeNull();
  });
  it('formats for display', () => {
    expect(formatContextTokens(134_218)).toBe('134K');
    expect(formatContextTokens(1_250_000)).toBe('1.3M');
  });
});

describe('compactedSinceLastInput', () => {
  const input = (source?: string) => ({ type: 'input:sent', data: { text: 'x', ...(source ? { source } : {}) } });
  it('is true when the compaction boundary is newer than the last real input', () => {
    expect(compactedSinceLastInput([input(), boundary(), { type: 'turn:end', data: {} }])).toBe(true);
    expect(compactedSinceLastInput([input(), input('command'), boundary()])).toBe(true);
  });
  it('is false once a real input follows the boundary', () => {
    expect(compactedSinceLastInput([boundary(), input()])).toBe(false);
    expect(compactedSinceLastInput([input()])).toBe(false);
  });
});

describe('stripContextRestore', () => {
  const block = `${CONTEXT_RESTORE_PREFIX} preamble…]\n\nYou are front\n\n${CONTEXT_RESTORE_END}\n\n`;
  it('returns the message as written', () => {
    expect(stripContextRestore(`${block}what did the worker find?`)).toBe('what did the worker find?');
    expect(stripContextRestore('plain')).toBe('plain');
  });
  it('lets a worker report underneath still be recognised', () => {
    expect(isWorkerInput(stripContextRestore(`${block}[Report from worker conv-x]\n\ndone`))).toBe(true);
  });
});

describe('stripPreamble', () => {
  it('shows a coordinator or worker first message as the caller wrote it', () => {
    const coordinator = buildCoordinatorPreamble({ conversationId: 'conv-c', workingDirectory: '/repo', cli: 'lattice' });
    expect(stripPreamble(`${coordinator}Look at the failing build.\n\n---\nnotes`)).toBe('Look at the failing build.\n\n---\nnotes');
    const worker = buildWorkerPreamble({ conversationId: 'conv-w', parentConversationId: 'conv-c', parentProvider: 'codex', parentModel: 'gpt-6-astra', workingDirectory: '/repo', cli: 'lattice' });
    expect(stripPreamble(`${worker}The user: check the tests.`)).toBe('The user: check the tests.');
  });
  it('leaves ordinary messages alone', () => {
    expect(stripPreamble('You are wrong about that\n---\nreally')).toBe('You are wrong about that\n---\nreally');
    expect(stripPreamble('plain')).toBe('plain');
  });
});
