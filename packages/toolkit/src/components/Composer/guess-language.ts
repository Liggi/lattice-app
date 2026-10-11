/**
 * Guess the language of a code block that names none, for its label only.
 * Each rule is a sign that ordinary prose or another language almost never
 * shows; anything less certain is no guess, and the block stays "Code".
 */

const lines = (code: string) => code.split('\n').filter((line) => line.trim() !== '');

const RULES: Array<[name: string, test: (code: string) => boolean]> = [
  ['JSON', (code) => {
    const text = code.trim();
    if (!/^[[{]/.test(text)) return false;
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }],
  ['Diff', (code) => /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m.test(code) || (/^--- \S/m.test(code) && /^\+\+\+ \S/m.test(code))],
  ['Python', (code) => /^Traceback \(most recent call last\):/m.test(code)
    || (/^\s*(def|class) \w+.*:\s*$/m.test(code) && !/[{};]\s*$/m.test(code))],
  // A prompt on the first line: `$ git status`.
  ['Shell', (code) => /^\s*\$ \S/.test(lines(code)[0] ?? '')],
  ['HTML', (code) => /^\s*<(!doctype html|[a-z][\w-]*)[\s>]/i.test(code) && /<\/[a-z][\w-]*>\s*$/i.test(code)],
  ['TypeScript', (code) => /^\s*(export\s+)?(interface|type) \w+(<[^>]*>)?\s*(=|\{)/m.test(code)
    || /\b(const|let) \w+: [A-Z]?\w+(\[\])?(<[^>]*>)? = /.test(code)],
  ['Go', (code) => /^package \w+$/m.test(code) || /^func (\(\w+ \*?\w+\) )?\w+\(.*\)( [\w*[\]().]+)? \{$/m.test(code)],
  ['Rust', (code) => /^\s*(pub )?fn \w+(<[^>]*>)?\(.*\)( -> .+)? \{$/m.test(code) || /\blet mut \w+/.test(code)],
  ['SQL', (code) => /^\s*(SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE (TABLE|INDEX|VIEW)|WITH \w+ AS)\b/m.test(code)
    && /\b(FROM|INTO|SET|TABLE|ON|AS)\b/.test(code)],
  ['CSS', (code) => /^[^{}\n]*[.#:\w\]-]\s*\{\s*$/m.test(code) && /^\s+[\w-]+:\s*[^;]+;\s*$/m.test(code) && /^\s*\}\s*$/m.test(code)],
];

/** The language's display name, or null when no sign is clear enough. */
export function guessLanguage(code: string): string | null {
  if (code.trim() === '') return null;
  for (const [name, test] of RULES) {
    if (test(code)) return name;
  }
  return null;
}
