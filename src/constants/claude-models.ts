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

// In the order the Claude CLI lists them, with its descriptions, so the list
// shown when the CLI can't be asked matches what it would have said.
export const CLAUDE_MODELS: ClaudeModelEntry[] = [
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
    id: 'claude-fable-5-1',
    label: 'Fable 5.1',
    description: 'For your toughest challenges',
    composerSelectable: true,
  },
  {
    id: 'claude-fable-5',
    label: 'Fable 5',
    description: 'Superseded, kept so older runs show their model',
    composerSelectable: false,
    supersededBy: 'claude-fable-5-1',
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

export function getClaudeModel(id: string): ClaudeModelEntry | undefined {
  return CLAUDE_MODELS.find((model) => model.id === id);
}

export function formatClaudeModelLabel(id: string): string {
  return getClaudeModel(id)?.label ?? id;
}
