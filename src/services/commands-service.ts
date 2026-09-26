import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from './infrastructure/logger.js';

export interface Command {
  name: string;
  type: 'builtin' | 'custom';
  description?: string;
  argumentHint?: string;
}

const logger = createLogger('CommandsService');

function normalizeWorkingDirectory(workingDirectory?: string): string | undefined {
  if (!workingDirectory) return undefined;
  if (workingDirectory === '~') return os.homedir();
  if (workingDirectory.startsWith('~/') || workingDirectory.startsWith('~\\')) {
    return path.join(os.homedir(), workingDirectory.slice(2));
  }
  return workingDirectory;
}

/**
 * Parse YAML frontmatter from a markdown file
 * Returns { description, argumentHint } or empty object if no frontmatter
 */
function parseYamlFrontmatter(filePath: string): { description?: string; argumentHint?: string } {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');

    // Check if file starts with frontmatter
    if (!content.startsWith('---')) {
      return {};
    }

    // Find the closing ---
    const endIndex = content.indexOf('---', 3);
    if (endIndex === -1) {
      return {};
    }

    const frontmatter = content.substring(3, endIndex).trim();
    const result: { description?: string; argumentHint?: string } = {};

    // Simple line-by-line parsing (avoiding yaml dependency)
    for (const line of frontmatter.split('\n')) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const key = line.substring(0, colonIndex).trim();
      let value = line.substring(colonIndex + 1).trim();

      // Remove quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      if (key === 'description') {
        result.description = value;
      } else if (key === 'argument-hint') {
        result.argumentHint = value;
      }
    }

    return result;
  } catch (error) {
    logger.debug('Failed to parse frontmatter', { filePath, error: error instanceof Error ? error.message : String(error) });
    return {};
  }
}

/**
 * Get hardcoded builtin commands
 */
export function getBuiltinCommands(): Command[] {
  return [
    { name: '/add-dir', type: 'builtin', description: 'Add a new working directory' },
    { name: '/clear', type: 'builtin', description: 'Clear conversation history and free up context' },
    { name: '/compact', type: 'builtin', description: 'Clear conversation history but keep a summary in context' },
    { name: '/init', type: 'builtin', description: 'Initialize a new CLAUDE.md file with codebase documentation' },
    { name: '/model', type: 'builtin', description: 'Set the AI model for Claude Code' },
    { name: '/permissions', type: 'builtin', description: 'Manage allow & deny tool permission rules' }
  ];
}

/**
 * Get custom commands from .claude/commands/ directories
 * Parses YAML frontmatter for description and argument-hint
 */
export function getCustomCommands(workingDirectory?: string): Command[] {
  const commands: Map<string, Command> = new Map();
  const normalizedWorkingDirectory = normalizeWorkingDirectory(workingDirectory);

  // Helper to process a directory
  const processDirectory = (dir: string) => {
    try {
      if (!fs.existsSync(dir)) return;

      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.endsWith('.md')) {
          const commandName = '/' + file.slice(0, -3); // Remove .md extension
          const filePath = path.join(dir, file);
          const frontmatter = parseYamlFrontmatter(filePath);

          commands.set(commandName, {
            name: commandName,
            type: 'custom',
            description: frontmatter.description,
            argumentHint: frontmatter.argumentHint,
          });
        }
      }
    } catch (error) {
      logger.warn('Failed to read commands directory', {
        error: error instanceof Error ? error.message : String(error),
        path: dir
      });
    }
  };

  // Always check global directory first
  const globalDir = path.join(os.homedir(), '.claude', 'commands');
  processDirectory(globalDir);

  // Check local directory if provided (overrides global)
  if (normalizedWorkingDirectory) {
    const localDir = path.join(normalizedWorkingDirectory, '.claude', 'commands');
    processDirectory(localDir);
  }

  return Array.from(commands.values());
}

/**
 * Get all available commands (builtin + custom)
 */
export function getAvailableCommands(workingDirectory?: string): Command[] {
  const builtin = getBuiltinCommands();
  const custom = getCustomCommands(workingDirectory);
  
  // Merge arrays
  return [...builtin, ...custom];
}
