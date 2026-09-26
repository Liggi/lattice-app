import { existsSync } from 'fs';
import { delimiter, join } from 'path';
import { homedir } from 'os';

/**
 * Directories a user-installed Claude Code is looked for when PATH has none.
 * PATH comes first so version managers (mise, nvm) win over a stale system copy.
 */
const FALLBACK_DIRS = (): string[] => [
  join(homedir(), '.local', 'bin'),
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/usr/bin',
];

/**
 * The user's own Claude Code executable, or null when none is installed.
 *
 * A workspace `node_modules` is never it: pnpm and npm exec put the
 * workspace's `.bin` first on PATH, and the binary there is whichever Claude
 * Code a dependency pinned, not the one the user signed in with. Every place
 * Lattice runs Claude (conversations, login, status, logout) resolves through
 * here so they all agree on which binary owns the credentials.
 */
export function findUserClaudeExecutable(pathValue: string | undefined = process.env.PATH): string | null {
  const dirs = (pathValue ?? '').split(delimiter).filter((dir) => dir && !dir.includes('node_modules'));
  for (const dir of [...dirs, ...FALLBACK_DIRS()]) {
    const candidate = join(dir, 'claude');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
