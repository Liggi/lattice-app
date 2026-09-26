/**
 * Skills Lattice ships to every Claude and Codex session it starts.
 *
 * The server writes them into its config dir on every start, with the agent
 * CLI's path filled in, and each session loads them from there: Claude through
 * `--plugin-dir` (so they appear as `lattice:<name>`), Codex through the
 * app-server's `skills/extraRoots/set` (so they appear as `lattice-<name>`).
 * Nothing is written to ~/.claude or ~/.codex, and a user's own skill of the
 * same name is left as it is and still offered.
 */

import fs from 'fs';
import path from 'path';
import { CONFIG_DIR } from '../../utils/constants.js';

export const AGENT_SKILLS_DIR = path.join(CONFIG_DIR, 'agent-skills');

/** The Claude plugin root, passed to `claude --plugin-dir`. */
export function claudePluginDir(root: string = AGENT_SKILLS_DIR): string {
  return path.join(root, 'claude');
}

/** The Codex skills root, passed to `skills/extraRoots/set`. */
export function codexSkillsRoot(root: string = AGENT_SKILLS_DIR): string {
  return path.join(root, 'codex');
}

interface ShippedSkill {
  name: string;
  description: string;
  body: (cli: string) => string;
}

const RESUME: ShippedSkill = {
  name: 'resume',
  description:
    'Use whenever the user asks to pick up, continue, or find where things stand on work done in an earlier session: '
    + '"pick up conv-X", "a while ago we worked on X, where is it?", "continue where we left off on Y", '
    + '"I had a branch for Z last week". Finds the session that did it and what it concluded, before you read the code. '
    + 'Not for questions about the current session, or fresh work with no earlier session behind it.',
  body: (cli) => `# Resume: pick up earlier session work

The goal is to work out where the work stands now, brief the user from zero, and carry on. Not to retell what the old session did.

Every command below is the Lattice CLI at \`${cli}\`. Sessions are named by ids like \`conv-…\`.

## If the user gave a session id

Go straight to **Orient**.

## If the user described the work

Find the session first:

1. \`${cli} session search <word>\` searches every session, archived ones included: the first message it was given, and its summary where one has been written. It matches one case-insensitive substring, so search for one distinctive word (a feature, a repo, a file name) rather than a phrase, and try a few.
2. Work often runs across several sessions: one that planned it and others it handed parts to. \`${cli} session list --all --since <YYYY-MM-DD>\` shows everything active in a date range (without \`--all\`, archived sessions are hidden, and most sessions end up archived).
3. Check each candidate with \`${cli} session grep <conv> <query>\` (full-text search inside one session) and \`${cli} session inputs <conv>\` (only the user's messages, which shows what was asked for and in what order).
4. If nothing turns up, widen once (other words, the repo name, a date range). Then tell the user what you searched and ask, rather than searching on.

If there are several plausible candidates, name them in a line each with the evidence, and ask which one before going further.

## Orient

1. \`${cli} session show <conv>\`: its summary, status and size.
2. \`${cli} session inputs <conv>\`: what the user asked for, in order.
3. \`${cli} session transcript <conv> --last 20\` (or \`--from <seq>\`): how it ended — what was finished, what was still in progress, what was promised.
4. A summary says what happened, not what is true now. Before repeating a decision or a "we fixed X", find it in the transcript.

## Check it against the present

How the session ended is a claim about the past. Check it before briefing:

- Branches and pull requests it created: do they still exist, and are they merged? (\`git branch -a\`, \`git log\`, \`gh pr list\` where GitHub is used.)
- Uncommitted work it left: is it still in the working tree?
- Anything it deployed, started or configured: is it still running or in place?
- A newer session on the same work, or the user's own notes: newer wins. Treat the old session as history, not as the current plan.

## Brief, then continue

One short paragraph from zero: what the work is, where it actually stands now after the checks, and what is still open. Say what was concluded rather than pointing at a session id. Then name the next step and take it. Stop to ask only if the direction genuinely splits; asking "should I continue?" after the user asked you to pick it up wastes their turn.
`,
};

const SHIPPED: readonly ShippedSkill[] = [RESUME];

function skillFile(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`;
}

/** Rewrite the shipped skills under `root`, naming `cli` as the Lattice command. */
export function writeAgentSkills(cli: string, root: string = AGENT_SKILLS_DIR): void {
  const temp = `${root}.${process.pid}.tmp`;
  fs.rmSync(temp, { recursive: true, force: true });
  const claude = claudePluginDir(temp);
  const codex = codexSkillsRoot(temp);
  fs.mkdirSync(path.join(claude, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(claude, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'lattice', description: 'Skills Lattice ships to its sessions.' }, null, 2) + '\n',
  );
  for (const skill of SHIPPED) {
    const body = skill.body(cli);
    fs.mkdirSync(path.join(claude, 'skills', skill.name), { recursive: true });
    fs.writeFileSync(path.join(claude, 'skills', skill.name, 'SKILL.md'), skillFile(skill.name, skill.description, body));
    const codexName = `lattice-${skill.name}`;
    fs.mkdirSync(path.join(codex, codexName), { recursive: true });
    fs.writeFileSync(path.join(codex, codexName, 'SKILL.md'), skillFile(codexName, skill.description, body));
  }
  fs.rmSync(root, { recursive: true, force: true });
  fs.renameSync(temp, root);
}
