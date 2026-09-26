/**
 * The CLI's argument contract. Every case here is a way the old hand-rolled
 * parser lied: `list --since 2026-08-01` exited 0 having filtered nothing,
 * `--model=claude-opus-5` (the form the help text itself printed) registered a
 * flag literally named "model=claude-opus-5" so the model was dropped, and
 * `show conv-a conv-b` silently ignored the second id.
 */

import { describe, expect, it } from 'vitest';
import {
  CliUsageError,
  SESSION_VERBS_BY_NAME,
  parseVerbArgs,
  renderSessionHelp,
  renderVerbHelp,
  suggestFlag,
} from '@/cli/session-cli-spec.js';
import { parseSinceDate, resolveItemLimit } from '@/cli/session-commands.js';

function verb(name: string) {
  const spec = SESSION_VERBS_BY_NAME.get(name);
  if (!spec) throw new Error(`no spec for ${name}`);
  return spec;
}

function parse(name: string, args: string[]) {
  return parseVerbArgs(verb(name), args);
}

describe('unknown flags', () => {
  it('rejects a flag the verb does not define instead of ignoring it', () => {
    expect(() => parse('list', ['--since-forever', '2026-08-01'])).toThrow(CliUsageError);
  });

  it('names the verb and points at its help', () => {
    let message = '';
    try {
      parse('tools', ['conv-x', '--sinc', '3']);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('unknown flag "--sinc"');
    expect(message).toContain('lattice session tools --help');
  });

  it('suggests the near miss', () => {
    expect(() => parse('list', ['--limt', '5'])).toThrow(/did you mean "--limit"/);
  });

  it('rejects single-dash flags rather than treating them as positionals', () => {
    expect(() => parse('show', ['-x'])).toThrow(/unknown flag "-x"/);
  });

  it('accepts --since on list, which is the flag that used to no-op', () => {
    expect(parse('list', ['--since', '2026-08-01']).flags.since).toBe('2026-08-01');
  });
});

describe('flag values', () => {
  it('parses --key=value, the form the old parser dropped on the floor', () => {
    expect(parse('new', ['--model=claude-opus-5']).flags.model).toBe('claude-opus-5');
  });

  it('parses --key value', () => {
    expect(parse('new', ['--model', 'claude-opus-5']).flags.model).toBe('claude-opus-5');
  });

  it('coerces int flags and rejects non-numbers', () => {
    expect(parse('inputs', ['conv-x', '--last', '3']).flags.last).toBe(3);
    expect(() => parse('inputs', ['conv-x', '--last', 'three'])).toThrow(/needs an integer/);
  });

  it('errors when a value-taking flag has no value', () => {
    expect(() => parse('inputs', ['conv-x', '--last'])).toThrow(/--last needs a value/);
  });

  it('does not let a boolean flag swallow the next positional', () => {
    // The old parser bound the query to --json, leaving grep with no query.
    const parsed = parse('grep', ['conv-x', '--json', 'timeout']);
    expect(parsed.flags.json).toBe(true);
    expect(parsed.named.query).toBe('timeout');
  });

  it('rejects a value on a boolean flag', () => {
    expect(() => parse('list', ['--all=please'])).toThrow(/takes no value/);
  });
});

describe('positionals', () => {
  it('requires the conversation id', () => {
    expect(() => parse('show', [])).toThrow(/requires <conv>/);
  });

  it('rejects extra positionals instead of ignoring them', () => {
    expect(() => parse('show', ['conv-a', 'conv-b'])).toThrow(/unexpected argument "conv-b"/);
  });

  it('joins rest positionals into one query', () => {
    expect(parse('grep', ['conv-x', 'no', 'such', 'file']).named.query).toBe('no such file');
  });

  it('requires a search query', () => {
    expect(() => parse('search', [])).toThrow(/requires <query>/);
  });
});

describe('--help', () => {
  it('is recognised for every verb and skips positional validation', () => {
    for (const name of SESSION_VERBS_BY_NAME.keys()) {
      expect(parse(name, ['--help']).helpRequested).toBe(true);
      expect(parse(name, ['-h']).helpRequested).toBe(true);
    }
  });

  it('documents every flag the verb actually accepts', () => {
    for (const [name, spec] of SESSION_VERBS_BY_NAME) {
      const help = renderVerbHelp(spec);
      for (const flag of spec.flags) {
        if (flag.hidden) continue;
        expect(help, `${name} help should mention --${flag.name}`).toContain(`--${flag.name}`);
      }
    }
  });

  it('lists every verb in the session help', () => {
    const help = renderSessionHelp();
    for (const name of SESSION_VERBS_BY_NAME.keys()) {
      expect(help).toContain(name);
    }
  });

  it('advertises the flags the top-level help used to hide', () => {
    expect(renderVerbHelp(verb('list'))).toContain('--project');
    expect(renderVerbHelp(verb('list'))).toContain('--tag');
    expect(renderVerbHelp(verb('inputs'))).toContain('--from');
    expect(renderVerbHelp(verb('inputs'))).toContain('--to');
  });
});

describe('--last / --from / --to precedence', () => {
  it('defaults to a cap rather than dumping a whole session', () => {
    expect(resolveItemLimit(parse('transcript', ['conv-x']))).toBe(50);
  });

  it('lets --last override the cap', () => {
    expect(resolveItemLimit(parse('transcript', ['conv-x', '--last', '3']))).toBe(3);
  });

  it('honours an explicit range whole — the caller already chose the window', () => {
    expect(resolveItemLimit(parse('transcript', ['conv-x', '--from', '10']))).toBeUndefined();
    expect(resolveItemLimit(parse('transcript', ['conv-x', '--to', '90']))).toBeUndefined();
  });

  it('applies --last inside an explicit range', () => {
    expect(
      resolveItemLimit(parse('tools', ['conv-x', '--from', '10', '--to', '90', '--last', '2'])),
    ).toBe(2);
  });
});

describe('--since parsing', () => {
  const now = new Date(2026, 7, 18, 12, 0, 0);

  it('reads YYYY-MM-DD as local midnight, not UTC midnight', () => {
    expect(parseSinceDate('2026-08-18', now)).toBe(new Date(2026, 7, 18).getTime());
  });

  it('accepts a full ISO timestamp', () => {
    expect(parseSinceDate('2026-08-18T09:30:00.000Z', now)).toBe(
      Date.parse('2026-08-18T09:30:00.000Z'),
    );
  });

  it('accepts "today"', () => {
    expect(parseSinceDate('today', now)).toBe(new Date(2026, 7, 18).getTime());
  });

  it('rejects what it cannot parse instead of filtering on NaN', () => {
    expect(parseSinceDate('last tuesday', now)).toBeNull();
  });
});

describe('suggestFlag', () => {
  it('stays quiet when nothing is close', () => {
    expect(suggestFlag('wildlyunrelated', ['limit', 'all'])).toBeNull();
  });

  it('does not guess wildly on short input', () => {
    expect(suggestFlag('abc', ['limit'])).toBeNull();
  });
});
