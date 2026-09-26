import { describe, it, expect } from 'vitest';
import { formatShellCommand } from '../utils/format-shell.js';

describe('formatShellCommand', () => {
  it('leaves short commands unchanged', () => {
    expect(formatShellCommand('ls -la')).toBe('ls -la');
    expect(formatShellCommand('git status')).toBe('git status');
  });

  it('breaks pipe chains', () => {
    const cmd = 'npm search shfmt --json 2>/dev/null | python3 -c "import json" 2>/dev/null || echo failed';
    const result = formatShellCommand(cmd);
    expect(result).toContain('\n');
    expect(result.split('\n').length).toBeGreaterThan(1);
    // First line should be the first command
    expect(result.split('\n')[0]).toContain('npm search');
    // Continuation lines should be indented
    expect(result.split('\n')[1]).toMatch(/^\s+\|/);
  });

  it('breaks && chains', () => {
    const cmd = 'cd /tmp && ls -la | sort -k5 -n | tail -20 && echo done';
    // Under 80 chars, stays on one line
    expect(formatShellCommand(cmd)).toBe(cmd);

    // Longer version
    const longCmd = 'cd /Users/alex/src/my-app && pnpm install 2>&1 | tail -2 && pnpm build 2>&1 | tail -5';
    const result = formatShellCommand(longCmd);
    expect(result).toContain('\n');
  });

  it('does not split inside double quotes', () => {
    const cmd = 'echo "this has a | pipe and && and || inside quotes" | grep something-very-long-to-exceed-threshold';
    const result = formatShellCommand(cmd);
    // The pipe inside quotes should NOT be a split point
    const lines = result.split('\n');
    expect(lines[0]).toContain('echo "this has a | pipe and && and || inside quotes"');
  });

  it('does not split inside single quotes', () => {
    const cmd = "echo 'this has a | pipe' | grep something-very-long-pattern-to-exceed-the-eighty-character-threshold-limit";
    const result = formatShellCommand(cmd);
    const lines = result.split('\n');
    expect(lines[0]).toContain("echo 'this has a | pipe'");
  });

  it('does not split inside $(...) subshells', () => {
    const cmd = 'echo $(cat /tmp/file | head -1) | grep pattern-very-long-to-exceed-the-eighty-character-threshold-limit-here';
    const result = formatShellCommand(cmd);
    // The pipe inside $() should stay on the first segment
    const lines = result.split('\n');
    expect(lines[0]).toContain('$(cat /tmp/file | head -1)');
  });

  it('leaves heredocs alone', () => {
    const cmd = "python3 << 'PYEOF'\nimport json\nprint(json.dumps({}))\nPYEOF";
    expect(formatShellCommand(cmd)).toBe(cmd);
  });

  it('handles semicolons', () => {
    const cmd = 'pkill -f "node.*dist/server.js" 2>/dev/null; pkill -f "nodemon" 2>/dev/null; sleep 1 && npm run dev &';
    const result = formatShellCommand(cmd);
    expect(result).toContain('\n');
  });
});
