/**
 * The skills Lattice ships to its sessions, written into the config dir so a
 * user's own skills folder is never touched.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudePluginDir, codexSkillsRoot, writeAgentSkills } from '../../src/services/infrastructure/agent-skills.js';

let root: string;

beforeEach(() => {
  root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent skills ')), 'agent-skills');
});

afterEach(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

describe('agent skills', () => {
  it('writes the resume skill as a Claude plugin and a Codex skills root, naming this server\'s CLI', () => {
    writeAgentSkills("'/opt/my config/bin/lattice'", root);

    const plugin = JSON.parse(fs.readFileSync(path.join(claudePluginDir(root), '.claude-plugin', 'plugin.json'), 'utf-8'));
    expect(plugin.name).toBe('lattice');
    const claude = fs.readFileSync(path.join(claudePluginDir(root), 'skills', 'resume', 'SKILL.md'), 'utf-8');
    const codex = fs.readFileSync(path.join(codexSkillsRoot(root), 'lattice-resume', 'SKILL.md'), 'utf-8');
    expect(claude).toMatch(/^---\nname: resume\ndescription: ".+"\n---\n/);
    expect(codex).toMatch(/^---\nname: lattice-resume\n/);
    expect(claude).toContain("`'/opt/my config/bin/lattice' session search <word>`");
    expect(claude.split('---\n').slice(2).join('---\n')).toBe(codex.split('---\n').slice(2).join('---\n'));
  });

  it('replaces what an earlier start wrote', () => {
    writeAgentSkills('/old/lattice', root);
    fs.writeFileSync(path.join(codexSkillsRoot(root), 'stale.md'), 'x');
    writeAgentSkills('/new/lattice', root);

    expect(fs.existsSync(path.join(codexSkillsRoot(root), 'stale.md'))).toBe(false);
    expect(fs.readFileSync(path.join(codexSkillsRoot(root), 'lattice-resume', 'SKILL.md'), 'utf-8')).not.toContain('/old/lattice');
  });
});
