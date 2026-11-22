import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from '../services/infrastructure/logger.js';
import { parseJson } from '../utils/json.js';

const logger = createLogger('ForeignTranscriptFields');

/**
 * Keys a translating endpoint adds to saved content blocks that Anthropic's
 * API refuses ("Extra inputs are not permitted"). LiteLLM keeps Gemini's
 * thought signature on each tool call as `provider_specific_fields`, so a
 * session that ran on Gemini fails every turn once it resumes on Claude.
 */
const FOREIGN_BLOCK_KEYS = ['provider_specific_fields'] as const;

/** The transcript `claude --resume <id>` reads: the cwd's project folder first, any project folder after. */
export async function findTranscript(sessionId: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const projects = path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const file = `${sessionId}.jsonl`;
  const direct = path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'), file);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const dir of await fs.promises.readdir(projects)) {
      const candidate = path.join(projects, dir, file);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

/** `line` without the foreign keys on its message's content blocks, or null when it has none. */
export function withoutForeignFields(line: string): string | null {
  if (!FOREIGN_BLOCK_KEYS.some((key) => line.includes(`"${key}"`))) return null;
  let parsed: unknown;
  try {
    parsed = parseJson(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const entry = parsed as { message?: { content?: unknown } };
  const content = entry.message?.content;
  if (!Array.isArray(content)) return null;
  let changed = false;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    for (const key of FOREIGN_BLOCK_KEYS) {
      if (key in block) {
        delete (block as Record<string, unknown>)[key];
        changed = true;
      }
    }
  }
  return changed ? JSON.stringify(entry) : null;
}

/**
 * Before a session resumes on a Claude model, removes the fields other
 * models' endpoints left in its transcript. Lines without them are kept byte
 * for byte, and the file is replaced in one rename.
 */
export async function removeForeignTranscriptFields(sessionId: string, cwd: string): Promise<number> {
  const file = await findTranscript(sessionId, cwd);
  if (!file) return 0;
  const text = await fs.promises.readFile(file, 'utf-8');
  if (!FOREIGN_BLOCK_KEYS.some((key) => text.includes(`"${key}"`))) return 0;
  let cleaned = 0;
  const lines = text.split('\n').map((line) => {
    const next = withoutForeignFields(line);
    if (next === null) return line;
    cleaned += 1;
    return next;
  });
  if (cleaned === 0) return 0;
  const temp = `${file}.lattice-clean-${process.pid}`;
  await fs.promises.writeFile(temp, lines.join('\n'));
  await fs.promises.rename(temp, file);
  logger.info('Removed other endpoints\' fields before resuming on Claude', { sessionId, file, lines: cleaned });
  return cleaned;
}
