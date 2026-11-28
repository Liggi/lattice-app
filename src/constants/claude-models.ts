export interface ClaudeModelEntry {
  id: string;
  label: string;
  description: string;
  composerSelectable: boolean;
  /** Listed under "Other models" when the menu falls back to this list. */
  other?: boolean;
  /** The model to use instead. Set means new sessions, resumes and switches refuse this id. */
  supersededBy?: string;
}

// Ordered by capability (Fable → Opus → Sonnet → Haiku), newest first within
// each family, matching the 2D Model × Effort pad.
export const CLAUDE_MODELS: ClaudeModelEntry[] = [
  {
    id: 'claude-fable-5-2',
    label: 'Fable 5.2',
    description: 'For your toughest challenges',
    composerSelectable: true,
  },
  {
    id: 'claude-fable-5-1',
    label: 'Fable 5.1',
    description: 'For your toughest challenges',
    composerSelectable: true,
    other: true,
  },
  {
    id: 'claude-fable-5',
    label: 'Fable 5',
    description: 'Superseded, kept so older runs show their model',
    composerSelectable: false,
    supersededBy: 'claude-fable-5-1',
  },
  {
    id: 'claude-opus-5-5',
    label: 'Opus 5.5',
    description: 'For complex work and everyday tasks',
    composerSelectable: true,
  },
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    description: 'Superseded, kept so older runs show their model',
    composerSelectable: false,
    supersededBy: 'claude-opus-5-5',
  },
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    description: 'Superseded, kept so older runs show their model',
    composerSelectable: false,
    supersededBy: 'claude-opus-5-5',
  },
  {
    id: 'claude-opus-4-7',
    label: 'Opus 4.7',
    description: 'Superseded, kept so older runs show their model',
    composerSelectable: false,
    supersededBy: 'claude-opus-5-5',
  },
  {
    id: 'claude-opus-4-6',
    label: 'Opus 4.6',
    description: 'Superseded, kept so older runs show their model',
    composerSelectable: false,
    supersededBy: 'claude-opus-5-5',
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Sonnet 5.5',
    description: 'Most efficient for simpler tasks',
    composerSelectable: true,
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    description: 'Efficient for routine tasks',
    composerSelectable: true,
    other: true,
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    label: 'Sonnet 4.5',
    description: 'Superseded, kept so older runs show their model',
    composerSelectable: false,
    supersededBy: 'claude-sonnet-5',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    description: 'Fastest for quick answers',
    composerSelectable: true,
  },
];

export interface ClaudeEffortEntry {
  id: string;
  label: string;
  shortLabel?: string;
  description: string;
  isDefault?: boolean;
}

export const CLAUDE_EFFORTS: ClaudeEffortEntry[] = [
  { id: 'default', label: 'Default', shortLabel: 'Default', description: 'Claude CLI default reasoning effort', isDefault: true },
  { id: 'low', label: 'Low', shortLabel: 'Low', description: 'Fast responses with minimal thinking' },
  { id: 'medium', label: 'Medium', shortLabel: 'Med', description: 'Balanced reasoning for everyday tasks' },
  { id: 'high', label: 'High', shortLabel: 'High', description: 'Deeper reasoning for complex problems' },
  { id: 'xhigh', label: 'Extra high', shortLabel: 'X-high', description: 'Extended reasoning for demanding work' },
  { id: 'max', label: 'Max', shortLabel: 'Max', description: 'Maximum reasoning depth' },
];

export const DEFAULT_CLAUDE_EFFORT = 'default';

/** Effort levels a Claude model supports, matching `claude --effort`. */
export function effortsForClaudeModel(id: string): string[] {
  const lower = id.toLowerCase();
  if (lower.includes('haiku')) return ['default'];
  if (/sonnet-5($|-\d|\[)/.test(lower) && !lower.includes('sonnet-5-5')) {
    return ['default', 'low', 'medium', 'high'];
  }
  if (lower.includes('sonnet')) {
    return ['default', 'low', 'medium', 'high', 'xhigh'];
  }
  return ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
}

export function getClaudeModel(id: string): ClaudeModelEntry | undefined {
  return CLAUDE_MODELS.find((model) => model.id === id);
}

export function formatClaudeModelLabel(id: string): string {
  return getClaudeModel(id)?.label ?? id;
}
