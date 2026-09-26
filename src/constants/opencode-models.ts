/**
 * Models Lattice offers for opencode sessions.
 *
 * IDs are opencode's own `provider/model` strings — the first segment is the
 * opencode provider, the rest is that provider's model id. `opencode/*` routes
 * through opencode zen, whose free tier needs no credentials; `openrouter/*`
 * requires a key in opencode's auth store.
 *
 * This list is not the full catalogue. opencode resolves models against a
 * cached copy of the models.dev registry, so anything it knows about works if
 * typed directly — these are just the ones surfaced in the picker.
 */

export interface OpencodeModelEntry {
  id: string;
  label: string;
  description: string;
  composerSelectable: boolean;
}

export const OPENCODE_MODELS: OpencodeModelEntry[] = [
  {
    id: 'opencode/x-preview-f-free',
    label: 'Ox Alpha',
    description: 'Stealth frontier model, 1M context, free during preview',
    composerSelectable: true,
  },
  {
    id: 'opencode/nemotron-3-ultra-free',
    label: 'Nemotron 3 Ultra',
    description: 'Free zen model — the stable control when Ox Alpha misbehaves',
    composerSelectable: true,
  },
  {
    id: 'opencode/deepseek-v4-flash-free',
    label: 'DeepSeek V4 Flash',
    description: 'Free zen model, fast',
    composerSelectable: true,
  },
];

export const DEFAULT_OPENCODE_MODEL_ID = 'opencode/x-preview-f-free';
