import { describe, it, expect } from 'vitest';
import { parseSlackText } from '../components/tools/mcp/slackText.js';
import { unwrapResult } from '../components/tools/mcp/unwrapResult.js';

// The layouts follow the hosted Slack connector's output; names and text are invented.

describe('unwrapResult on connector text', () => {
  it('peels a single long string field to its text', () => {
    const raw = JSON.stringify({ messages: 'Channel: #design (C0000001)\n\nAda Byron <ada@example.com>: hello [2026-01-02 09:30:00 GMT]', pagination_info: 'No more.' });
    const u = unwrapResult(raw);
    expect(u.text.startsWith('Channel: #design')).toBe(true);
  });

  it('leaves records with nested values as JSON', () => {
    const u = unwrapResult(JSON.stringify({ message_link: 'https://example.com/p1', message_context: { ts: '1' } }));
    expect(u.kind).toBe('json');
  });
});

describe('parseSlackText', () => {
  it('reads a detailed thread with replies, reactions and files', () => {
    const text = [
      '=== THREAD PARENT MESSAGE ===',
      'From: Ada Byron <ada@example.com> (U0000001)',
      'Time: 2026-01-02 09:30:00 GMT',
      'Message TS: 1700000000.000100',
      'Has anyone tried the new build?',
      'Reactions: eyes (2)',
      '',
      '=== THREAD REPLIES (1 total) ===',
      '',
      '--- Reply 1 of 1 ---',
      'From: Grace Hopper <grace@example.com> (U0000002)',
      'Time: 2026-01-02 09:41:00 GMT',
      'Message TS: 1700000000.000200',
      'Yes, see attached.',
      'Files: notes.txt (ID: F0000001, text/plain, 1 KB)',
    ].join('\n');
    const p = parseSlackText(text);
    expect(p?.messages).toHaveLength(2);
    expect(p?.messages[0]).toMatchObject({ name: 'Ada Byron', time: 'Jan 2 09:30', text: 'Has anyone tried the new build?', reactions: 'eyes (2)' });
    expect(p?.messages[1]).toMatchObject({ name: 'Grace Hopper', isReply: true, text: 'Yes, see attached.', files: 'notes.txt (text/plain, 1 KB)' });
  });

  it('reads a concise thread', () => {
    const p = parseSlackText('THREAD: Lunch? [Ada Byron <ada@example.com>]\n\n> Grace Hopper <grace@example.com>: Sure\n> Ada Byron <ada@example.com>: Noon then');
    expect(p?.messages.map((m) => m.name)).toEqual(['Ada Byron', 'Grace Hopper', 'Ada Byron']);
    expect(p?.messages[2].text).toBe('Noon then');
  });

  it('reads a channel in both layouts and skips the channel header', () => {
    const concise = parseSlackText('Channel: DM (D0000001)\n\nAda Byron <ada@example.com>: first [2026-01-02 09:30:00 GMT]\n\nGrace Hopper <grace@example.com>: second\nline [2026-01-02 09:31:00 GMT]');
    expect(concise?.channel).toBe('DM');
    expect(concise?.messages.map((m) => m.text)).toEqual(['first', 'second\nline']);

    const detailed = parseSlackText('Channel: #design (C0000001)\n\n=== Message from Ada Byron <ada@example.com> (U0000001) at 2026-01-02 09:30:00 GMT === \nMessage TS: 1700000000.000100\nhello');
    expect(detailed?.channel).toBe('#design');
    expect(detailed?.messages[0]).toMatchObject({ name: 'Ada Byron', text: 'hello' });
  });

  it('reads search results in both layouts', () => {
    const detailed = parseSlackText([
      '# Search Results for: ',
      '',
      '## Messages (1 results)',
      '### Result 1 of 1',
      'Channel: #design (ID: C0000001)',
      'From: Build Bot (ID: U0000009)  [BOT]',
      'Time: 2026-01-02 09:30:00 GMT',
      'Message_ts: 1700000000.000100',
      'Permalink: [link](https://example.slack.com/archives/C0000001/p1700000000000100)',
      'Text: ',
      'Build passed',
      '',
      '---',
    ].join('\n'));
    expect(detailed?.messages[0]).toMatchObject({ name: 'Build Bot', bot: true, channel: '#design', text: 'Build passed', permalink: 'https://example.slack.com/archives/C0000001/p1700000000000100' });

    const concise = parseSlackText('# Search Results for: \n\n## Messages (2 results)\n(2 results)\n1. #design - ada: first idea 2026-01-02 09:30:00 GMT\n2. #random - grace: second\nidea 2026-01-03 10:00:00 GMT');
    expect(concise?.messages.map((m) => [m.channel, m.name, m.text, m.time])).toEqual([
      ['#design', 'ada', 'first idea', 'Jan 2 09:30'],
      ['#random', 'grace', 'second\nidea', 'Jan 3 10:00'],
    ]);
  });

  it('returns null for prose that is not messages', () => {
    expect(parseSlackText('# Search Results for: \n\nNo results found.\n')).toBeNull();
    expect(parseSlackText('File upload completed successfully!')).toBeNull();
  });
});
