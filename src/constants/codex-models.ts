export interface CodexModelEntry {
  id: string;
  label: string;
  description: string;
  composerSelectable: boolean;
  efforts: string[];
  /** The model to use instead. Set means new sessions, resumes and switches refuse this id. */
  supersededBy?: string;
}

export interface CodexEffortEntry {
  id: string;
  label: string;
  description: string;
}

export const CODEX_MODELS: CodexModelEntry[] = [
  {
    id: 'gpt-6.1-sol',
    label: 'Sol 6.1',
    description: 'Capable model for sustained coding and agent work',
    composerSelectable: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    id: 'gpt-6-astra',
    label: 'Astra 6',
    description: 'Most capable model for complex, demanding work',
    composerSelectable: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    id: 'gpt-5.6-sol',
    label: 'Sol 5.6',
    description: 'Latest frontier agentic coding model',
    composerSelectable: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    id: 'gpt-5.6-terra',
    label: 'Terra 5.6',
    description: 'Balanced agentic coding model for everyday work',
    composerSelectable: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    id: 'gpt-5.6-luna',
    label: 'Luna 5.6',
    description: 'Fast and affordable agentic coding model',
    composerSelectable: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    description: 'Strong model for everyday coding',
    composerSelectable: false,
    efforts: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    description: 'Superseded, kept so older runs show their model',
    composerSelectable: false,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    supersededBy: 'gpt-5.6-luna',
  },
  {
    id: 'gpt-5.3-codex-spark',
    label: 'GPT-5.3 Codex Spark',
    description: 'Ultra-fast coding model',
    composerSelectable: false,
    efforts: ['low', 'medium', 'high', 'xhigh'],
  },
];

export const CODEX_EFFORTS: CodexEffortEntry[] = [
  {
    id: 'low',
    label: 'Low',
    description: 'Fast responses with lighter reasoning',
  },
  {
    id: 'medium',
    label: 'Medium',
    description: 'Balances speed and reasoning depth for everyday tasks',
  },
  {
    id: 'high',
    label: 'High',
    description: 'Greater reasoning depth for complex problems',
  },
  {
    id: 'xhigh',
    label: 'XHigh',
    description: 'Extra high reasoning depth for complex problems',
  },
  {
    id: 'max',
    label: 'Max',
    description: 'Maximum reasoning depth for the hardest problems',
  },
  {
    id: 'ultra',
    label: 'Ultra',
    description: 'Maximum reasoning with automatic task delegation',
  },
];

export const DEFAULT_CODEX_MODEL_ID = 'gpt-6-astra';
export const DEFAULT_CODEX_EFFORT = 'xhigh';

export function getCodexModel(id: string): CodexModelEntry | undefined {
  return CODEX_MODELS.find((model) => model.id === id);
}

export function formatCodexModelLabel(id: string): string {
  return getCodexModel(id)?.label ?? id;
}

export function effortsForCodexModel(id: string): string[] {
  return getCodexModel(id)?.efforts ?? getCodexModel(DEFAULT_CODEX_MODEL_ID)!.efforts;
}
