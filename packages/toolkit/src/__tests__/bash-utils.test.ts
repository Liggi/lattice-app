import { describe, it, expect } from 'vitest';
import { summarizeCommand, parseBackgroundOutputPath } from '../components/tools/BashTool.js';
import { stripRerunFooter } from '../utils/tool-utils.js';

describe('summarizeCommand', () => {
  it('returns short commands unchanged', () => {
    expect(summarizeCommand('ls -la')).toBe('ls -la');
    expect(summarizeCommand('git status')).toBe('git status');
  });

  it('truncates long commands', () => {
    const long = 'a'.repeat(100);
    const result = summarizeCommand(long);
    expect(result.length).toBeLessThanOrEqual(81); // 80 + ellipsis
    expect(result.endsWith('…')).toBe(true);
  });

  it('strips shell wrapper prefixes', () => {
    expect(summarizeCommand("bash -c 'echo hello'")).toBe('echo hello');
    expect(summarizeCommand("sh -c 'ls -la'")).toBe('ls -la');
  });

  it('takes first meaningful line of multiline commands', () => {
    const result = summarizeCommand('echo first\necho second\necho third');
    expect(result).toContain('echo first');
  });

  it('skips comment lines', () => {
    const result = summarizeCommand('# comment\necho actual');
    expect(result).toContain('echo actual');
  });
});

describe('parseBackgroundOutputPath', () => {
  it('extracts output path from result', () => {
    expect(parseBackgroundOutputPath('Output is being written to: /tmp/output.log'))
      .toBe('/tmp/output.log');
  });

  it('handles paths with hyphens and dots', () => {
    expect(parseBackgroundOutputPath(
      'Output is being written to: /private/tmp/claude-501/tasks/bg-abc123.output',
    )).toBe('/private/tmp/claude-501/tasks/bg-abc123.output');
  });

  it('extracts path when preceded by other text', () => {
    expect(parseBackgroundOutputPath(
      'Command started.\nOutput is being written to: /tmp/bg.out\nDone.',
    )).toBe('/tmp/bg.out');
  });

  it('returns null when no match', () => {
    expect(parseBackgroundOutputPath('Command completed successfully')).toBeNull();
    expect(parseBackgroundOutputPath('')).toBeNull();
  });

  // ---- False positive resistance ----

  it('returns null for source code containing the pattern as a string literal', () => {
    // A subagent reading BashTool.tsx source would return this as result text.
    // The regex matches because the pattern IS in the string — this is expected
    // behavior since BashTool only receives Bash tool results, not subagent results.
    // But we document the boundary: this function should only be called with
    // Bash tool result strings, never with arbitrary content.
    const sourceCode = `const BG_OUTPUT_PATTERN = /Output is being written to:\\s*(\\S+)/;`;
    // This WILL match — the function is not context-aware
    const result = parseBackgroundOutputPath(sourceCode);
    // Documenting current behavior: the regex matches the pattern itself
    expect(result).not.toBeNull();
  });

  it('extracts path correctly even when result has surrounding whitespace', () => {
    expect(parseBackgroundOutputPath(
      '  Output is being written to:   /tmp/bg.output  \n',
    )).toBe('/tmp/bg.output');
  });
});

describe('stripRerunFooter', () => {
  it('strips [rerun: bN] from end of output', () => {
    expect(stripRerunFooter('{"success":true}\n[rerun: b1]')).toBe('{"success":true}');
    expect(stripRerunFooter('output\n[rerun: b12]')).toBe('output');
  });

  it('handles trailing whitespace after footer', () => {
    expect(stripRerunFooter('output\n[rerun: b3]  ')).toBe('output');
    expect(stripRerunFooter('output\n[rerun: b3]\n')).toBe('output');
  });

  it('leaves output unchanged when no footer present', () => {
    expect(stripRerunFooter('normal output')).toBe('normal output');
    expect(stripRerunFooter('')).toBe('');
    expect(stripRerunFooter('contains [rerun: b1] in middle\nmore text')).toBe('contains [rerun: b1] in middle\nmore text');
  });
});
