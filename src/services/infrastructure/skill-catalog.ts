/**
 * What a Claude skill is for, read from its SKILL.md frontmatter, so the chat
 * can say it where the agent invokes the skill. The Skill tool's own result is
 * only "Launching skill: <name>", so the file is the one source.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { claudePluginDir } from './agent-skills.js';
import { parseJson } from '../../utils/json.js';

export interface SkillDescription {
  name: string;
  /** The description's first sentence, or null when there is none worth showing. */
  summary: string | null;
  /** The whole frontmatter description, or null when the SKILL.md was not found. */
  description: string | null;
}

function readFrontmatterDescription(file: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const lines = fm[1].split(/\r?\n/);
  const i = lines.findIndex((l) => /^description:/.test(l));
  if (i < 0) return null;
  let value = lines[i].replace(/^description:\s*/, '');
  if (/^[>|][-+]?$/.test(value)) {
    const block: string[] = [];
    for (const l of lines.slice(i + 1)) {
      if (l.trim() && !/^\s/.test(l)) break;
      block.push(l.trim());
    }
    value = block.join(' ');
  }
  value = value.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value.trim() || null;
}

/**
 * The first sentence says what the skill is for when it is written that way
 * ("Author or edit a GitHub pull request description."). Descriptions that
 * open with routing text ("Use whenever the user asks…") have no such
 * sentence, and get no summary.
 */
export function summarizeDescription(description: string): string | null {
  const first = description.split(/(?<=[.!?])\s+(?=[A-Z"'(`])/)[0].trim();
  if (/^(use|invoke|trigger|call)\b/i.test(first)) return null;
  return first;
}

function pluginSkillFile(plugin: string, skill: string): string | null {
  if (plugin === 'lattice') return path.join(claudePluginDir(), 'skills', skill, 'SKILL.md');
  try {
    const registry = parseJson(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf-8')) as {
      plugins?: Record<string, Array<{ installPath?: string }>>;
    };
    for (const [key, installs] of Object.entries(registry.plugins ?? {})) {
      if (key.split('@')[0] !== plugin) continue;
      const installPath = installs[0]?.installPath;
      if (installPath) return path.join(installPath, 'skills', skill, 'SKILL.md');
    }
  } catch {
    return null;
  }
  return null;
}

/** Looks the skill up where Claude loads it from: a plugin, the project, then the user's own skills. */
export function describeSkill(name: string, cwd?: string): SkillDescription {
  const candidates: string[] = [];
  const colon = name.indexOf(':');
  if (colon > 0) {
    const file = pluginSkillFile(name.slice(0, colon), name.slice(colon + 1));
    if (file) candidates.push(file);
  } else {
    if (cwd) candidates.push(path.join(cwd, '.claude', 'skills', name, 'SKILL.md'));
    candidates.push(path.join(os.homedir(), '.claude', 'skills', name, 'SKILL.md'));
  }
  for (const file of candidates) {
    const description = readFrontmatterDescription(file);
    if (description) return { name, description, summary: summarizeDescription(description) };
  }
  return { name, description: null, summary: null };
}
