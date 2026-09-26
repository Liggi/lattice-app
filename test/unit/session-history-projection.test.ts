/**
 * Projection + rendering for `lattice session ...`.
 *
 * The Codex cases are the load-bearing ones. The Codex app-server streams one
 * content event per token, so a transcript of a real Codex session printed
 * 13,000 lines reading `[12702] v` / `[12703] 3` — one word per paragraph.
 * Fixtures here mirror the observed shape: consecutive events sharing a
 * `messageId`, each carrying a one-token text block.
 */

import { describe, expect, it } from 'vitest';
import {
  projectGrep,
  projectInputs,
  projectTools,
  projectTranscript,
  renderGrep,
  renderList,
  renderTools,
  renderTranscript,
  toolNameMatches,
  windowItems,
  windowNote,
} from '@/session-history/renderer.js';
import type { RawEvent, SessionListItem } from '@/session-history/types.js';

let nextSeq = 1;

function event(type: string, data: unknown, seq = nextSeq++): RawEvent {
  return {
    conversationId: 'conv-test',
    seq,
    runId: 'run-1',
    timestamp: 1_700_000_000_000 + seq,
    type,
    data,
    meta: null,
  };
}

function userInput(text: string): RawEvent {
  return event('input:sent', { text });
}

function textEvent(text: string, messageId: string): RawEvent {
  return event('content', { blocks: [{ type: 'text', text }], messageId });
}

function thinkingEvent(text: string, messageId: string): RawEvent {
  return event('content', { blocks: [{ type: 'thinking', thinking: text }], messageId });
}

function toolUseEvent(name: string, input: Record<string, unknown>, id: string, messageId = 'm-t') {
  return event('content', { blocks: [{ type: 'tool_use', name, input, id }], messageId });
}

function toolResultEvent(toolUseId: string, content: string): RawEvent {
  return event('result', { blocks: [{ type: 'tool_result', tool_use_id: toolUseId, content }] });
}

/** One Codex message arriving as a token stream, as the app-server sends it. */
function codexTokens(tokens: string[], messageId = 'codex-msg_1'): RawEvent[] {
  return tokens.map((t) => textEvent(t, messageId));
}

describe('transcript coalescing', () => {
  it('joins a streamed Codex message into one turn', () => {
    const lines = projectTranscript(codexTokens(['I', '’m', ' starting', ' from', ' the', ' top']));
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('I’m starting from the top');
  });

  it('reports the seq range it folded, so `event <seq>` still works', () => {
    nextSeq = 100;
    const lines = projectTranscript(codexTokens(['a', 'b', 'c']));
    expect(lines[0].seq).toBe(100);
    expect(lines[0].endSeq).toBe(102);
    expect(renderTranscript(lines)).toContain('[100-102] assistant: abc');
  });

  it('leaves a single-event turn without a range', () => {
    const lines = projectTranscript([textEvent('One shot.', 'm-1')]);
    expect(lines[0].endSeq).toBeUndefined();
    expect(renderTranscript(lines)).toMatch(/^\[\d+\] assistant: One shot\./);
  });

  it('--raw keeps one line per event', () => {
    const lines = projectTranscript(codexTokens(['I', '’m', ' back']), { raw: true });
    expect(lines).toHaveLength(3);
    expect(lines[1].text).toBe('’m');
  });

  it('does not merge separate messages', () => {
    const lines = projectTranscript([
      ...codexTokens(['first ', 'message'], 'msg-a'),
      ...codexTokens(['second ', 'message'], 'msg-b'),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['first message', 'second message']);
  });

  it('does not merge across a user turn', () => {
    const lines = projectTranscript([
      textEvent('before', 'msg-a'),
      userInput('interrupt'),
      textEvent('after', 'msg-a'),
    ]);
    expect(lines.map((l) => l.role)).toEqual(['assistant', 'user', 'assistant']);
  });

  it('does not splice two paragraphs that a tool call sits between', () => {
    const lines = projectTranscript([
      textEvent('Let me look.', 'msg-a'),
      toolUseEvent('Bash', { command: 'ls' }, 'tu-1', 'msg-a'),
      textEvent('Found it.', 'msg-a'),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['Let me look.', 'Found it.']);
  });

  it('does not merge events with no message id to hang the join on', () => {
    const lines = projectTranscript([
      event('content', { blocks: [{ type: 'text', text: 'one' }] }),
      event('content', { blocks: [{ type: 'text', text: 'two' }] }),
    ]);
    expect(lines).toHaveLength(2);
  });

  it('marks a coalesced thinking block once, not once per token', () => {
    const lines = projectTranscript(
      [thinkingEvent('Plann', 'rs-1'), thinkingEvent('ing the work', 'rs-1')],
      { includeThinking: true },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('[thinking] Planning the work');
  });

  it('keeps thinking out unless asked', () => {
    const lines = projectTranscript([thinkingEvent('quiet', 'rs-1'), textEvent('loud', 'm-1')]);
    expect(lines.map((l) => l.text)).toEqual(['loud']);
  });

  it('keeps thinking and text of one message apart', () => {
    const lines = projectTranscript(
      [thinkingEvent('deliberating', 'm-1'), textEvent('answer', 'm-1')],
      { includeThinking: true },
    );
    expect(lines.map((l) => l.text)).toEqual(['[thinking] deliberating', 'answer']);
  });
});

describe('windowItems', () => {
  it('keeps the last N, which is what --last 1 has to mean for inputs', () => {
    const lines = projectInputs([userInput('first'), userInput('second'), userInput('third')]);
    const window = windowItems(lines, 1);
    expect(window.items.map((l) => l.text)).toEqual(['third']);
    expect(window.total).toBe(3);
    expect(window.dropped).toBe(2);
  });

  it('keeps everything when no limit is set', () => {
    expect(windowItems([1, 2, 3]).items).toEqual([1, 2, 3]);
    expect(windowItems([1, 2, 3]).dropped).toBe(0);
  });

  it('is a no-op when the limit exceeds the item count', () => {
    expect(windowNote(windowItems([1, 2], 50), 'turns')).toBeNull();
  });

  it('says what it hid rather than truncating silently', () => {
    const note = windowNote(windowItems([1, 2, 3], 1), 'turns');
    expect(note).toContain('showing the last 1 of 3 turns');
    expect(note).toContain('2 older hidden');
  });
});

describe('tools', () => {
  it('matches a tool name case-insensitively, by substring', () => {
    expect(toolNameMatches('Bash', 'bash')).toBe(true);
    expect(toolNameMatches('BashOutput', 'bash')).toBe(true);
    expect(toolNameMatches('Read', 'bash')).toBe(false);
  });

  it('filters with that rule, so --name bash finds Bash', () => {
    const events = [
      toolUseEvent('Bash', { command: 'ls' }, 'tu-1'),
      toolUseEvent('Read', { file_path: '/tmp/x' }, 'tu-2'),
      toolUseEvent('BashOutput', { bash_id: '1' }, 'tu-3'),
    ];
    const calls = projectTools(events, { nameFilter: 'bash' });
    expect(calls.map((c) => c.name)).toEqual(['Bash', 'BashOutput']);
  });

  it('cross-references the result event', () => {
    const events = [toolUseEvent('Bash', { command: 'ls' }, 'tu-1'), toolResultEvent('tu-1', 'ok')];
    const rendered = renderTools(projectTools(events));
    expect(rendered).toMatch(/\[\d+ -> \d+\] Bash {2}ls/);
  });
});

describe('grep', () => {
  const events = [
    userInput('why does the timeout fire'),
    textEvent('The timeout comes from the daemon.', 'm-1'),
    thinkingEvent('timeout is probably the reaper', 'm-1'),
    toolResultEvent('tu-1', 'PASS test-a\nFAIL timeout in playwright dump'),
  ];

  it('searches every role by default', () => {
    expect(projectGrep(events, 'timeout')).toHaveLength(4);
  });

  it('narrows to one role', () => {
    const hits = projectGrep(events, 'timeout', { roles: ['assistant'] });
    expect(hits).toHaveLength(1);
    expect(hits[0].role).toBe('assistant');
  });

  it('separates thinking from assistant text', () => {
    expect(projectGrep(events, 'timeout', { roles: ['thinking'] })).toHaveLength(1);
  });

  it('drops the tool-result noise when asked for what was said', () => {
    const hits = projectGrep(events, 'timeout', { roles: ['user', 'assistant'] });
    expect(hits.map((h) => h.role)).toEqual(['user', 'assistant']);
  });

  it('labels hits by role rather than by raw event type', () => {
    const rendered = renderGrep(projectGrep(events, 'timeout'), 'timeout');
    expect(rendered).toContain('] user:');
    expect(rendered).toContain('] tool:');
  });

  it('reports the total hit count, including hits past the limit', () => {
    const all = projectGrep(events, 'timeout');
    const window = windowItems(all, 2);
    const rendered = renderGrep(window.items, 'timeout', window.total);
    expect(rendered).toContain('4 matches for "timeout"');
    expect(rendered).toContain('showing the last 2');
  });

  it('says so when nothing matched', () => {
    expect(renderGrep([], 'nothing')).toContain('(no matches for "nothing")');
  });
});

describe('renderList', () => {
  function item(overrides: Partial<SessionListItem> = {}): SessionListItem {
    return {
      conversationId: 'conv-abc',
      customName: null,
      archived: false,
      createdAt: '2026-01-01T09:00:00.000Z',
      updatedAt: '2026-01-01T09:00:00.000Z',
      lastActivityAt: '2026-08-18T14:10:25.806Z',
      model: 'claude-opus-5',
      eventCount: 157,
      summary: null,
      ...overrides,
    };
  }

  /** Same local-time formatting the renderer uses, computed independently. */
  function localStamp(iso: string): string {
    const d = new Date(iso);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  it('dates a row by last activity, not by when it was created', () => {
    const rendered = renderList([item()]);
    expect(rendered).toContain(localStamp('2026-08-18T14:10:25.806Z'));
    expect(rendered).not.toContain('2026-01-01');
  });

  it('falls back to the created date for a session with no events', () => {
    const rendered = renderList([item({ lastActivityAt: null })]);
    expect(rendered).toContain(localStamp('2026-01-01T09:00:00.000Z'));
  });

  it('prints the model, which used to be provider-only', () => {
    expect(renderList([item()])).toContain('claude-opus-5');
  });

  it('prints the running state when one was derived', () => {
    const statuses = new Map([['conv-abc', 'running']]);
    expect(renderList([item()], { statuses })).toContain('running');
    expect(renderList([item()])).not.toContain('running');
  });

  it('marks archived rows', () => {
    expect(renderList([item({ archived: true })])).toContain('(archived)');
  });

  it('--summaries prints a wrapped summary instead of a files dump', () => {
    const rendered = renderList(
      [
        item({
          summary: {
            conversationId: 'conv-abc',
            project: 'lattice',
            title: 'Fix the CLI',
            summary: 'A '.repeat(200) + 'end',
            notable: null,
            tags: [],
            filesTouched: ['/a/very/long/path.ts', '/another/path.ts'],
            eventCount: 157,
            startedAt: null,
            endedAt: null,
            status: 'complete',
            generatorModel: null,
            generatedAt: null,
          },
        }),
      ],
      { summaries: true },
    );
    expect(rendered).toContain('Fix the CLI');
    expect(rendered).not.toContain('/a/very/long/path.ts');
    // Header plus exactly two summary lines.
    expect(rendered.trimEnd().split('\n')).toHaveLength(3);
  });
});
