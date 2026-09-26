import { parseJson } from './json.js';

export function formatFilePath(path: string, workingDirectory?: string): string {
  if (!path) return path;
  if (workingDirectory && path.startsWith(workingDirectory)) {
    const relativePath = path.slice(workingDirectory.length);
    const cleaned = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
    return cleaned ? `./${cleaned}` : './';
  }
  const commonHomePaths = ['/home/', '/Users/'];
  for (const homePattern of commonHomePaths) {
    if (path.startsWith(homePattern)) return `~${path.slice(homePattern.length - 1)}`;
  }
  return path;
}

export function countLines(content: string): number {
  if (!content) return 0;
  const newlineCount = (content.match(/\n/g) || []).length;
  return content.length > 0 ? newlineCount + 1 : 0;
}

export function extractFileCount(content: string): number {
  if (!content) return 0;
  const lines = content.split('\n').filter(line => line.trim().length > 0);
  const fileLines = lines.filter(line => line.match(/^\s*-\s+/));
  return fileLines.length || lines.length;
}

interface TodoItem {
  id: string;
  content: string;
  status: string;
}

export function parseTodos(content: string): TodoItem[] {
  try {
    const parsed: unknown = parseJson(content);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is TodoItem =>
        item !== null &&
        typeof item === 'object' &&
        'content' in item &&
        'status' in item &&
        typeof (item as TodoItem).content === 'string' &&
        typeof (item as TodoItem).status === 'string'
      );
    }
  } catch {
    // Not valid JSON
  }
  return [];
}

/** Strip the `[rerun: bN]` footer that Claude Code appends to Bash tool results. */
export function stripRerunFooter(text: string): string {
  return text.replace(/\n?\[rerun: b\d+\]\s*$/, '');
}

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
