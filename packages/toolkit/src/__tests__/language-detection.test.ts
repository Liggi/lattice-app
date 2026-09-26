import { describe, it, expect } from 'vitest';
import { detectLanguageFromPath } from '../utils/language-detection.js';

describe('detectLanguageFromPath', () => {
  it('detects common extensions', () => {
    expect(detectLanguageFromPath('app.tsx')).toBe('tsx');
    expect(detectLanguageFromPath('index.ts')).toBe('typescript');
    expect(detectLanguageFromPath('main.py')).toBe('python');
    expect(detectLanguageFromPath('style.css')).toBe('css');
    expect(detectLanguageFromPath('data.json')).toBe('json');
    expect(detectLanguageFromPath('script.sh')).toBe('bash');
    expect(detectLanguageFromPath('main.go')).toBe('go');
    expect(detectLanguageFromPath('lib.rs')).toBe('rust');
  });

  it('handles full paths', () => {
    expect(detectLanguageFromPath('/Users/alex/src/project/src/index.tsx')).toBe('tsx');
    expect(detectLanguageFromPath('./relative/path/config.yaml')).toBe('yaml');
  });

  it('detects known filenames without extensions', () => {
    expect(detectLanguageFromPath('Dockerfile')).toBe('dockerfile');
    expect(detectLanguageFromPath('Makefile')).toBe('makefile');
    expect(detectLanguageFromPath('.gitignore')).toBe('gitignore');
    expect(detectLanguageFromPath('.bashrc')).toBe('bash');
    expect(detectLanguageFromPath('Gemfile')).toBe('ruby');
  });

  it('returns text for unknown extensions', () => {
    expect(detectLanguageFromPath('file.xyz')).toBe('text');
    expect(detectLanguageFromPath('README')).toBe('text');
  });

  it('returns text for empty/missing paths', () => {
    expect(detectLanguageFromPath('')).toBe('text');
  });

  it('handles case-insensitive extensions', () => {
    expect(detectLanguageFromPath('FILE.JS')).toBe('javascript');
    expect(detectLanguageFromPath('page.HTML')).toBe('html');
  });
});
