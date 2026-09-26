/**
 * Pattern-based permission matching for granular tool control.
 *
 * Supports Claude Code-style patterns:
 * - Bash - all bash commands
 * - Bash(npm *) - bash commands starting with "npm "
 * - Bash(git commit *) - bash commands starting with "git commit "
 * - Write(src/**) - write to any file under src/
 * - Write(*.ts) - write to any .ts file
 * - Edit(src/**.tsx) - edit .tsx files under src/
 * - Read - all read operations
 *
 * Pattern syntax:
 * - * matches any characters except path separators
 * - ** matches any characters including path separators
 * - Patterns without parentheses match the entire tool (e.g., Bash matches all bash)
 */

import { minimatch } from 'minimatch';

// Tool input field mappings - which field to match against for each tool
const TOOL_MATCH_FIELDS: Record<string, string> = {
  Bash: 'command',
  Write: 'file_path',
  Read: 'file_path',
  Edit: 'file_path',
  Glob: 'pattern',
  Grep: 'pattern',
  // MCP tools use the full tool name as the pattern
};

export interface PermissionPattern {
  tool: string;           // e.g., "Bash", "Write"
  pattern: string | null; // e.g., "npm *", "src/**", null for all
  raw: string;            // Original pattern string for display/storage
}

/**
 * Parse a permission pattern string into its components.
 *
 * Examples:
 * - "Bash" -> { tool: "Bash", pattern: null, raw: "Bash" }
 * - "Bash(npm *)" -> { tool: "Bash", pattern: "npm *", raw: "Bash(npm *)" }
 * - "Write(src/**)" -> { tool: "Write", pattern: "src/**", raw: "Write(src/**)" }
 */
export function parsePattern(patternStr: string): PermissionPattern {
  const match = patternStr.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\((.+)\))?$/);

  if (!match) {
    // Invalid pattern, treat as literal tool name
    return { tool: patternStr, pattern: null, raw: patternStr };
  }

  const [, tool, pattern] = match;
  return {
    tool,
    pattern: pattern || null,
    raw: patternStr,
  };
}

/**
 * Convert a Claude Code-style pattern to a regex or minimatch pattern.
 *
 * For Bash commands:
 * - "npm *" matches "npm install", "npm run test", etc.
 * - "*" is converted to match any non-newline characters
 *
 * For file paths:
 * - "src/**" matches any file under src/
 * - "*.ts" matches any .ts file
 * - Uses minimatch for glob-style matching
 */
function matchesPattern(value: string, pattern: string, isPath: boolean): boolean {
  if (isPath) {
    // Use minimatch for file path patterns (supports ** and *)
    return minimatch(value, pattern, {
      matchBase: true,  // Match basename if pattern has no slashes
      dot: true,        // Match dotfiles
    });
  } else {
    // For command matching, convert simple wildcards to regex
    // "npm *" should match "npm install" but not "npm"
    // "*" matches any characters
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape special regex chars except *
      .replace(/\*/g, '.*');                  // Convert * to .*

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(value);
  }
}

/**
 * Extract the matchable value from a tool input based on tool type.
 */
export function getMatchableValue(toolName: string, input: Record<string, unknown>): string | null {
  const field = TOOL_MATCH_FIELDS[toolName];

  if (!field) {
    // Unknown tool or MCP tool - no pattern matching support
    return null;
  }

  const value = input[field];
  return typeof value === 'string' ? value : null;
}

/**
 * Check if a tool invocation matches a permission pattern.
 *
 * @param pattern - The parsed permission pattern
 * @param toolName - The tool being invoked (e.g., "Bash")
 * @param input - The tool input parameters
 * @returns true if the pattern allows this invocation
 */
export function matchesPermission(
  pattern: PermissionPattern,
  toolName: string,
  input: Record<string, unknown>
): boolean {
  // Tool name must match
  if (pattern.tool !== toolName) {
    return false;
  }

  // If no pattern specified, match all invocations of this tool
  if (!pattern.pattern) {
    return true;
  }

  const value = getMatchableValue(toolName, input);
  if (value === null) {
    // Can't extract matchable value - no match
    return false;
  }

  // Determine if this is a path-based tool
  const isPath = ['Write', 'Read', 'Edit', 'Glob'].includes(toolName);

  return matchesPattern(value, pattern.pattern, isPath);
}

/**
 * Check if a tool invocation is allowed by any pattern in a list.
 *
 * @param patterns - List of permission pattern strings
 * @param toolName - The tool being invoked
 * @param input - The tool input parameters
 * @returns The matching pattern if allowed, null otherwise
 */
export function isAllowedByPatterns(
  patterns: string[],
  toolName: string,
  input: Record<string, unknown>
): string | null {
  for (const patternStr of patterns) {
    const pattern = parsePattern(patternStr);
    if (matchesPermission(pattern, toolName, input)) {
      return patternStr;
    }
  }
  return null;
}

/**
 * Extract the primary command from a complex bash command.
 * Handles pipes, chains (&&, ;), and redirections.
 *
 * Examples:
 * - "fd -e tsx . ~/lattice | head -30" -> "fd -e tsx . ~/lattice"
 * - "git add . && git commit -m 'msg'" -> "git add ."
 * - "echo 'test' > file.txt && cat file.txt" -> "echo 'test'"
 */
function extractPrimaryCommand(command: string): string {
  // Remove leading/trailing whitespace
  let cmd = command.trim();

  // Find the first pipe or chain operator (not inside quotes)
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let cutIndex = -1;

  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i];
    const prevChar = i > 0 ? cmd[i - 1] : '';

    if (char === "'" && prevChar !== '\\' && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === '"' && prevChar !== '\\' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    } else if (!inSingleQuote && !inDoubleQuote) {
      // Check for pipe or chain operators
      if (char === '|' || char === ';') {
        cutIndex = i;
        break;
      }
      if (char === '&' && cmd[i + 1] === '&') {
        cutIndex = i;
        break;
      }
    }
  }

  if (cutIndex > 0) {
    cmd = cmd.substring(0, cutIndex).trim();
  }

  // Remove output redirections from end (> file, >> file, 2>&1, etc.)
  // Be careful to preserve redirections that are part of the command meaning
  cmd = cmd.replace(/\s*(?:2>&1|>&2|>\s*\S+|>>\s*\S+)\s*$/, '').trim();

  return cmd;
}

/**
 * Extract the base command (first word) and identify the tool type.
 * Returns command metadata for generating meaningful patterns.
 */
interface CommandInfo {
  baseCommand: string;      // e.g., "git", "npm", "fd"
  subCommand: string | null; // e.g., "commit", "install", null
  fullCommand: string;       // The primary command (after extracting from pipes/chains)
}

function analyzeCommand(command: string): CommandInfo {
  const primary = extractPrimaryCommand(command);
  const parts = primary.split(/\s+/).filter(p => p.length > 0);

  if (parts.length === 0) {
    return { baseCommand: '', subCommand: null, fullCommand: primary };
  }

  const baseCommand = parts[0];

  // Commands that have meaningful subcommands
  const commandsWithSubcommands = new Set([
    'git', 'npm', 'pnpm', 'yarn', 'docker', 'kubectl', 'systemctl',
    'cargo', 'go', 'pip', 'python', 'node', 'deno', 'bun',
    'gh', 'aws', 'gcloud', 'az', 'terraform', 'make',
  ]);

  // Check if second part is a subcommand (not a flag)
  let subCommand: string | null = null;
  if (parts.length > 1 && commandsWithSubcommands.has(baseCommand)) {
    const second = parts[1];
    // Subcommands don't start with - and aren't paths
    if (!second.startsWith('-') && !second.includes('/')) {
      subCommand = second;
    }
  }

  return { baseCommand, subCommand, fullCommand: primary };
}

/**
 * Generate suggested patterns for a given tool invocation.
 * Returns patterns from most specific to least specific.
 *
 * For bash commands, handles complex multi-part commands:
 * - Extracts primary command before pipes (|) and chains (&&, ;)
 * - Recognizes common CLI tools and their subcommands
 * - Generates meaningful intermediate patterns
 *
 * Examples for Bash(fd -e tsx . ~/lattice | head -30):
 * - "Bash(fd -e tsx . ~/lattice | head -30)" - exact command
 * - "Bash(fd *)" - any fd command
 * - "Bash" - all bash
 *
 * Examples for Bash(git commit -m "message"):
 * - "Bash(git commit -m "message")" - exact command
 * - "Bash(git commit *)" - any git commit
 * - "Bash(git *)" - any git command
 * - "Bash" - all bash
 *
 * Examples for Write(src/components/Button.tsx):
 * - "Write(src/components/Button.tsx)" - exact file
 * - "Write(src/components/[star].tsx)" - any tsx in components
 * - "Write(src/[starstar]/[star].tsx)" - any tsx under src
 * - "Write([star].tsx)" - any tsx file
 * - "Write" - all writes
 */
export function suggestPatterns(
  toolName: string,
  input: Record<string, unknown>
): string[] {
  const suggestions: string[] = [];
  const value = getMatchableValue(toolName, input);

  if (!value) {
    // No matchable value - just return tool-level permission
    return [toolName];
  }

  if (toolName === 'Bash') {
    const { baseCommand, subCommand, fullCommand } = analyzeCommand(value);

    // 1. Exact command (safest) - always include full original
    suggestions.push(`Bash(${value})`);

    // 2. If command was extracted from pipes/chains, offer the primary command
    if (fullCommand !== value && fullCommand.length > 0) {
      suggestions.push(`Bash(${fullCommand})`);
    }

    // 3. If there's a subcommand, offer "base subcommand *" pattern
    if (subCommand) {
      suggestions.push(`Bash(${baseCommand} ${subCommand} *)`);
    }

    // 4. Offer "base *" pattern for the base command
    if (baseCommand) {
      suggestions.push(`Bash(${baseCommand} *)`);
    }

    // 5. All bash commands (broadest)
    suggestions.push(toolName);
  } else if (['Write', 'Read', 'Edit'].includes(toolName)) {
    // For file operations, suggest path patterns from specific to broad
    const filePath = value;
    const fileName = filePath.split('/').pop() || filePath;
    const ext = fileName.includes('.') ? fileName.split('.').pop() : null;
    const dirPath = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : null;

    // 1. Exact file (safest)
    suggestions.push(`${toolName}(${filePath})`);

    // 2. Same directory, same extension (e.g., src/components/*.tsx)
    if (dirPath && ext) {
      suggestions.push(`${toolName}(${dirPath}/*.${ext})`);
    }

    // 3. Recursive from directory with same extension (e.g., src/**/*.tsx)
    if (dirPath && ext) {
      // Find the top-level directory for recursive pattern
      const topDir = dirPath.split('/')[0];
      if (topDir && topDir !== dirPath) {
        suggestions.push(`${toolName}(${topDir}/**/*.${ext})`);
      }
    }

    // 4. Any file with this extension anywhere (e.g., *.tsx)
    if (ext) {
      suggestions.push(`${toolName}(*.${ext})`);
    }

    // 5. All operations of this tool (broadest)
    suggestions.push(toolName);
  } else {
    // Unknown tool type - just exact and all
    suggestions.push(`${toolName}(${value})`);
    suggestions.push(toolName);
  }

  // Remove duplicates while preserving order
  return [...new Set(suggestions)];
}
