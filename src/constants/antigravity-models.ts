/**
 * Models Lattice offers for Antigravity CLI (`agy`) sessions.
 *
 * Lattice ids carry an `agy:` prefix so they never collide with Claude or
 * Codex ids. `agy` names a model and its thinking level in one id
 * (`gemini-4-neon-high`); the picker shows the model and the level apart, and
 * `antigravityModelId` joins them. The adapter strips the prefix before
 * passing `--model` to `agy`. Ids are the ones `agy models` listed on 22 Nov 2026.
 */

export interface AntigravityModelEntry {
  /** The model without its thinking level, as the picker lists it. */
  id: string;
  label: string;
  description: string;
  /** Thinking levels `agy` offers for this model, lowest first. */
  efforts: string[];
  defaultEffort: string;
}

export const ANTIGRAVITY_MODEL_PREFIX = 'agy:';

export const ANTIGRAVITY_MODELS: AntigravityModelEntry[] = [
  { id: 'agy:gemini-4-neon', label: 'Gemini 4 Neon', description: 'Strong all-round model for coding and agent work', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
  { id: 'agy:gemini-4-carbon', label: 'Gemini 4 Carbon', description: 'Most capable, for the hardest work', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
  { id: 'agy:gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', description: 'Faster and cheaper than Neon', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
  { id: 'agy:gemini-3.8-flash', label: 'Gemini 3.8 Flash', description: 'Fastest; works without a paid plan', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
];

export const ANTIGRAVITY_EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
};

/** The picker's default row. */
export const DEFAULT_ANTIGRAVITY_PICKER_ID = 'agy:gemini-4-neon';

/** The full id a session starts on when none is named. */
export const DEFAULT_ANTIGRAVITY_MODEL_ID = 'agy:gemini-4-neon-high';

/** The picker row a full or level-less id belongs to. */
export function antigravityModelEntry(model: string | null | undefined): AntigravityModelEntry | undefined {
  if (!model) return undefined;
  return ANTIGRAVITY_MODELS.find((m) => model === m.id || m.efforts.some((e) => model === `${m.id}-${e}`));
}

/** The full id for a picker row and a thinking level; a level the model lacks falls to its default. */
export function antigravityModelId(pickerId: string, effort?: string | null): string {
  const entry = antigravityModelEntry(pickerId);
  if (!entry || pickerId !== entry.id) return pickerId;
  return `${entry.id}-${effort && entry.efforts.includes(effort) ? effort : entry.defaultEffort}`;
}

/** Every full id with a label that names its thinking level, for a place that shows one id at a time. */
export function antigravityFullModels(): Array<{ id: string; label: string }> {
  return ANTIGRAVITY_MODELS.flatMap((m) => m.efforts.map((e) => ({
    id: `${m.id}-${e}`,
    label: `${m.label} (${ANTIGRAVITY_EFFORT_LABELS[e] ?? e})`,
  })));
}

/** The id `agy --model` takes for a Lattice Antigravity model id. */
export function agyModelArg(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const full = antigravityModelId(model);
  return full.startsWith(ANTIGRAVITY_MODEL_PREFIX) ? full.slice(ANTIGRAVITY_MODEL_PREFIX.length) : full;
}
