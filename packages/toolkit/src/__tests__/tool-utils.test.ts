import { describe, it, expect } from 'vitest';
import { formatFilePath, countLines, extractFileCount, parseTodos, extractDomain } from '../utils/tool-utils.js';

describe('formatFilePath', () => {
  it('makes paths relative to working directory', () => {
    expect(formatFilePath('/home/user/project/src/index.ts', '/home/user/project')).toBe('./src/index.ts');
    expect(formatFilePath('/home/user/project', '/home/user/project')).toBe('./');
  });

  it('shortens home directory paths', () => {
    expect(formatFilePath('/Users/alex/src/file.ts')).toBe('~/alex/src/file.ts');
    expect(formatFilePath('/home/alex/src/file.ts')).toBe('~/alex/src/file.ts');
  });

  it('returns absolute paths unchanged when no match', () => {
    expect(formatFilePath('/opt/data/file.txt')).toBe('/opt/data/file.txt');
  });

  it('handles empty paths', () => {
    expect(formatFilePath('')).toBe('');
  });

  it('prefers working directory over home shortening', () => {
    expect(formatFilePath('/Users/alex/project/src/a.ts', '/Users/alex/project')).toBe('./src/a.ts');
  });
});

describe('countLines', () => {
  it('counts lines correctly', () => {
    expect(countLines('one\ntwo\nthree')).toBe(3);
    expect(countLines('single line')).toBe(1);
    expect(countLines('')).toBe(0);
  });

  it('handles trailing newlines', () => {
    expect(countLines('a\nb\n')).toBe(3);
  });
});

describe('extractFileCount', () => {
  it('counts lines from content', () => {
    expect(extractFileCount('file1\nfile2\nfile3')).toBe(3);
    expect(extractFileCount('')).toBe(0);
  });

  it('ignores blank lines', () => {
    expect(extractFileCount('file1\n\nfile2\n\n')).toBe(2);
  });
});

describe('parseTodos', () => {
  it('parses valid todo JSON', () => {
    const json = JSON.stringify([
      { id: '1', content: 'Fix bug', status: 'pending' },
      { id: '2', content: 'Write tests', status: 'completed' },
    ]);
    const todos = parseTodos(json);
    expect(todos).toHaveLength(2);
    expect(todos[0].content).toBe('Fix bug');
    expect(todos[1].status).toBe('completed');
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseTodos('not json')).toEqual([]);
    expect(parseTodos('')).toEqual([]);
  });

  it('filters out malformed items', () => {
    const json = JSON.stringify([
      { id: '1', content: 'Valid', status: 'pending' },
      { content: 123, status: 'pending' },  // content not string
      null,
    ]);
    expect(parseTodos(json)).toHaveLength(1);
  });
});

describe('extractDomain', () => {
  it('extracts hostname from URLs', () => {
    expect(extractDomain('https://example.com/path')).toBe('example.com');
    expect(extractDomain('https://sub.domain.org:8080/foo')).toBe('sub.domain.org');
  });

  it('returns input for invalid URLs', () => {
    expect(extractDomain('not-a-url')).toBe('not-a-url');
  });
});
