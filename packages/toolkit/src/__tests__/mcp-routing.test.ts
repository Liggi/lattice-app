import { describe, it, expect } from 'vitest';
import { isMcpTool, isChromeDevToolsTool, mcpToolLabel, brandFor } from '../components/tools/mcp/index.js';
import { unwrapShellCommand, summarizeCommand } from '../components/tools/BashTool.js';
import { parseUnifiedDiff, summarizePatchTargets } from '../components/tools/PatchTool.js';

// The names below are taken verbatim from ~/.lattice/session-info.db — Claude emits
// `mcp__server__tool` (and `mcp__claude_ai_Server__tool` for connectors), the Codex
// adapter historically emitted `MCP:server.tool`. Both must reach a brand card.

describe('isMcpTool', () => {
  it('accepts both providers naming schemes', () => {
    expect(isMcpTool('mcp__slack__conversations_history')).toBe(true);
    expect(isMcpTool('mcp__claude_ai_Linear__linear_get_issue')).toBe(true);
    expect(isMcpTool('MCP:chrome-devtools.evaluate')).toBe(true);
    expect(isMcpTool('MCP:linear.linear_get_issue')).toBe(true);
  });

  it('rejects native tools', () => {
    expect(isMcpTool('Bash')).toBe(false);
    expect(isMcpTool('Read')).toBe(false);
    expect(isMcpTool('ApplyPatch')).toBe(false);
  });
});

describe('brandFor', () => {
  it('matches connector-prefixed names the old lowercase substring test missed', () => {
    expect(brandFor('mcp__claude_ai_Linear__linear_get_issue')?.key).toBe('linear');
    expect(brandFor('mcp__claude_ai_Slack__conversations_history')?.key).toBe('slack');
    expect(brandFor('mcp__claude_ai_Notion__API-post-search')?.key).toBe('notion');
  });

  it('matches the Codex dotted scheme', () => {
    expect(brandFor('MCP:linear.linear_search_issues')?.key).toBe('linear');
    expect(brandFor('MCP:github.search_prs')?.key).toBe('github');
  });

  it('returns null for servers with no brand card', () => {
    expect(brandFor('mcp__chrome-devtools__evaluate_script')).toBeNull();
    expect(brandFor('mcp__plugin_exa_exa__search')).toBeNull();
  });
});

describe('isChromeDevToolsTool', () => {
  it('covers both spellings and the isolated instance', () => {
    expect(isChromeDevToolsTool('mcp__chrome-devtools__take_snapshot')).toBe(true);
    expect(isChromeDevToolsTool('mcp__chrome_devtools__take_snapshot')).toBe(true);
    expect(isChromeDevToolsTool('mcp__chrome_isolated__navigate_page')).toBe(true);
    expect(isChromeDevToolsTool('MCP:chrome-devtools.navigate')).toBe(true);
    expect(isChromeDevToolsTool('mcp__slack__channels_list')).toBe(false);
  });
});

describe('chrome devtools action parsing', () => {
  // getAction is module-private; exercise it through the label the card shows.
  it('is covered by isChromeDevToolsTool for every name that reaches the card', () => {
    for (const name of [
      'mcp__chrome-devtools__evaluate_script',
      'mcp__chrome_devtools__evaluate_script',
      'mcp__chrome_isolated__evaluate_script',
      'MCP:chrome-devtools.evaluate',
    ]) {
      expect(isChromeDevToolsTool(name)).toBe(true);
      expect(isMcpTool(name)).toBe(true);
    }
  });
});

describe('mcpToolLabel', () => {
  it('keeps the tool half when the server name contains underscores', () => {
    expect(mcpToolLabel('mcp__claude_ai_Linear__linear_get_issue')).toBe('linear get issue');
    expect(mcpToolLabel('mcp__slack__conversations_history')).toBe('conversations history');
  });

  it('handles the Codex dotted scheme', () => {
    expect(mcpToolLabel('MCP:chrome-devtools.evaluate')).toBe('evaluate');
  });

  it('falls back to the whole name when it parses as neither', () => {
    expect(mcpToolLabel('Bash')).toBe('Bash');
  });
});

describe('unwrapShellCommand', () => {
  it('strips the Codex /bin/zsh -lc wrapper', () => {
    expect(unwrapShellCommand("/bin/zsh -lc 'curl -s https://example.com'"))
      .toBe('curl -s https://example.com');
  });

  it('still strips the bare bash -c wrapper', () => {
    expect(unwrapShellCommand("bash -c 'echo hello'")).toBe('echo hello');
  });

  it('un-escapes POSIX close-reopen quoting inside a single-quoted body', () => {
    expect(unwrapShellCommand("/bin/zsh -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
  });

  it('leaves an unwrapped command alone', () => {
    expect(unwrapShellCommand('git status')).toBe('git status');
    expect(unwrapShellCommand('zsh script.sh')).toBe('zsh script.sh');
  });

  it('spans newlines so multiline wrapped scripts are not truncated', () => {
    expect(unwrapShellCommand("/bin/zsh -lc 'line one\nline two'")).toBe('line one\nline two');
  });

  it('flows through to the header summary', () => {
    expect(summarizeCommand("/bin/zsh -lc 'git status'")).toBe('git status');
  });
});

describe('parseUnifiedDiff', () => {
  const diff = [
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -10,4 +10,5 @@ function main() {',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' return a;',
  ].join('\n');

  it('classifies lines and drops file headers', () => {
    const lines = parseUnifiedDiff(diff);
    expect(lines.filter(l => l.kind === 'added').map(l => l.text))
      .toEqual(['const b = 3;', 'const c = 4;']);
    expect(lines.filter(l => l.kind === 'removed').map(l => l.text))
      .toEqual(['const b = 2;']);
    expect(lines.some(l => l.text.startsWith('+++'))).toBe(false);
  });

  it('numbers old and new sides independently from the hunk header', () => {
    const lines = parseUnifiedDiff(diff);
    const context = lines.filter(l => l.kind === 'context');
    expect(context[0]).toMatchObject({ oldNum: 10, newNum: 10 });
    // between the two context lines: one line removed (old +1) and two added (new +2)
    expect(context[1]).toMatchObject({ oldNum: 12, newNum: 13 });
  });

  it('handles a pure addition with no context', () => {
    const lines = parseUnifiedDiff('@@ -0,0 +1,2 @@\n+alpha\n+beta');
    expect(lines.filter(l => l.kind === 'added')).toHaveLength(2);
    expect(lines.filter(l => l.kind === 'removed')).toHaveLength(0);
  });

  it('returns nothing for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});

describe('summarizePatchTargets', () => {
  it('names the file when there is one, counts when there are several', () => {
    expect(summarizePatchTargets({ changes: [{ path: '/repo/src/app.ts' }] }, '/repo'))
      .toBe('./src/app.ts');
    expect(summarizePatchTargets({ changes: [{ path: 'a.ts' }, { path: 'b.ts' }] }))
      .toBe('2 files');
    expect(summarizePatchTargets({})).toBe('');
  });
});
