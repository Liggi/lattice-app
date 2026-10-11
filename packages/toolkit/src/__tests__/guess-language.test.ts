import { describe, it, expect } from 'vitest';
import { guessLanguage } from '../components/Composer/guess-language.js';

describe('guessLanguage', () => {
  it('names code with an unmistakable sign', () => {
    expect(guessLanguage('{\n  "name": "lattice"\n}')).toBe('JSON');
    expect(guessLanguage('@@ -1,2 +1,2 @@\n-a\n+b')).toBe('Diff');
    expect(guessLanguage('Traceback (most recent call last):\n  File "a.py", line 1\nKeyError: 1')).toBe('Python');
    expect(guessLanguage('def load(path):\n    return open(path).read()')).toBe('Python');
    expect(guessLanguage('$ git status\nOn branch main')).toBe('Shell');
    expect(guessLanguage('interface User {\n  id: string;\n}')).toBe('TypeScript');
    expect(guessLanguage('SELECT id FROM users WHERE id = 1;')).toBe('SQL');
    expect(guessLanguage('fn main() {\n    println!("hi");\n}')).toBe('Rust');
  });

  it('leaves prose, short snippets and look-alikes unnamed', () => {
    expect(guessLanguage('This is just text I wanted to quote\nacross two lines.')).toBeNull();
    expect(guessLanguage('npm test')).toBeNull();
    expect(guessLanguage("expect(label).toBe('Opus 5.5')")).toBeNull();
    expect(guessLanguage('Note: select the file from the list.')).toBeNull();
    expect(guessLanguage('12:28:55 PM [Server] listening on http://127.0.0.1:3881')).toBeNull();
    expect(guessLanguage('{ not json')).toBeNull();
  });
});
