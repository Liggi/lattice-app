import { describe, it, expect } from 'vitest';
import { errorMessage } from '../components/ToolError.js';
import { describeCron } from '../components/tools/FallbackTool.js';
import { rankColumns } from '../components/tools/mcp/unwrapResult.js';

describe('errorMessage', () => {
  it('takes the message out of MCP and API error wrapping', () => {
    expect(errorMessage('MCP error -32603: Failed to list projects')).toBe('Failed to list projects');
    const api = JSON.stringify({ name: 'APIResponseError', status: 400, body: JSON.stringify({ object: 'error', message: 'No matches found' }) });
    expect(errorMessage(api)).toBe('No matches found');
    expect(errorMessage('<tool_use_error>No scheduled job with id \'abc\'</tool_use_error>')).toBe("No scheduled job with id 'abc'");
  });

  it('keeps plain errors as they are', () => {
    expect(errorMessage('Exit code 1\nboom')).toBe('Exit code 1\nboom');
  });
});

describe('describeCron', () => {
  it('reads one-off, daily and hourly expressions', () => {
    expect(describeCron('23 8 25 9 *')).toBe('Sep 25 08:23');
    expect(describeCron('0 9 * * *')).toBe('daily at 09:00');
    expect(describeCron('7 * * * *')).toBe('hourly at :07');
    expect(describeCron('*/5 * * * 1-5')).toBe('*/5 * * * 1-5');
  });
});

describe('rankColumns', () => {
  it('drops empty columns and puts the name ahead of a mostly-empty description', () => {
    const header = ['description', 'name', 'notes'];
    const rows = [['', 'Alpha', ''], ['', 'Beta', ''], ['A long description of the third project', 'Gamma', '']];
    expect(rankColumns(header, rows)).toEqual([1, 0]);
  });
});
