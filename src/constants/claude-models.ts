export interface ClaudeModelEntry {
  id: string;
  label: string;
  description: string;
  composerSelectable: boolean;
  /** The model to use instead. Set means new sessions, resumes and switches refuse this id. */
  supersededBy?: string;
}

export const CLAUDE_MODELS: ClaudeModelEntry[] = [
  {
    id: 'claude-fable-5-1',
    label: 'Fable 5.1',
    description: 'Fast everyday model for most sessions',
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
    id: 'claude-opus-5-5',
    label: 'Opus 5.5',
    description: 'Most capable model for hard reasoning and long tasks',
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
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    description: 'Balanced speed and capability for general work',
    composerSelectable: true,
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
    description: 'Cheapest and fastest for simple, high-volume tasks',
    composerSelectable: false,
  },
];

export function getClaudeModel(id: string): ClaudeModelEntry | undefined {
  return CLAUDE_MODELS.find((model) => model.id === id);
}

export function formatClaudeModelLabel(id: string): string {
  return getClaudeModel(id)?.label ?? id;
}
