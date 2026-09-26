import fs from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

// Every entry here must exist on disk. A missing entry is a hard failure, not a
// skip — the list drifted to 8 non-existent files once and the check kept
// reporting a pass count that included them.
const DOC_FILES = [
  'CLAUDE.md',
];

const ROOT_LEVEL_DOCS = new Set([
  'CLAUDE.md',
  'AGENTS.md',
  'ARCHITECTURE.md',
  'README.md',
  'package.json',
  'docs/README.md',
  'docs/current/README.md',
]);

const PATH_PREFIXES = [
  'src/',
  'docs/',
  'test/',
  'scripts/',
  'public/',
  'data/',
];

const SYMBOL_ASSERTIONS: Array<{ file: string; symbol: string }> = [
  { file: 'src/server/register-app-routes.ts', symbol: 'registerAppRoutes' },
  { file: 'src/services/insights/anthropic-service.ts', symbol: 'DEFAULT_MODELS' },
  { file: 'src/services/gemini-service.ts', symbol: 'CONSULT_MODEL' },
  { file: 'src/web/chat/components/MessageList/message-list-constants.ts', symbol: 'BLOCK_BUDGET_BASE' },
];

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

function isRepoPath(value: string): boolean {
  return ROOT_LEVEL_DOCS.has(value) || PATH_PREFIXES.some(prefix => value.startsWith(prefix));
}

function cleanCandidate(value: string): string {
  return value
    .trim()
    .replace(/^[("'`]+/, '')
    .replace(/[)"'`,.:;]+$/, '');
}

function collectReferencedPaths(text: string): Set<string> {
  const refs = new Set<string>();
  const withoutFencedBlocks = text.replace(/```[\s\S]*?```/g, '');

  const addIfPath = (value: string) => {
    const cleaned = cleanCandidate(value);
    if (!cleaned || cleaned.includes('<') || cleaned.startsWith('http') || cleaned.includes('*')) return;
    if (isRepoPath(cleaned)) refs.add(cleaned);
  };

  for (const match of withoutFencedBlocks.matchAll(/`([^`\n]+)`/g)) {
    addIfPath(match[1]);
  }

  for (const match of withoutFencedBlocks.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    addIfPath(match[1]);
  }

  return refs;
}

const errors: string[] = [];

for (const docFile of DOC_FILES) {
  const docPath = path.join(repoRoot, docFile);
  if (!fs.existsSync(docPath)) {
    errors.push(`Missing tracked doc: ${docFile}`);
    continue;
  }

  const text = readFile(docFile);
  for (const ref of collectReferencedPaths(text)) {
    const absRef = path.join(repoRoot, ref);
    if (!fs.existsSync(absRef)) {
      errors.push(`${docFile}: referenced path does not exist -> ${ref}`);
    }
  }
}

for (const assertion of SYMBOL_ASSERTIONS) {
  const filePath = path.join(repoRoot, assertion.file);
  if (!fs.existsSync(filePath)) {
    errors.push(`Symbol assertion file missing -> ${assertion.file}`);
    continue;
  }

  const text = readFile(assertion.file);
  if (!text.includes(assertion.symbol)) {
    errors.push(`Expected symbol ${assertion.symbol} not found in ${assertion.file}`);
  }
}

if (errors.length > 0) {
  console.error('Documentation drift check failed:\n');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Documentation drift check passed for ${DOC_FILES.length} docs and ${SYMBOL_ASSERTIONS.length} symbol assertions.`);
