/**
 * The model Lattice offers for Inkling sessions: Inkling 2 Mini, run on this
 * machine by `inkling acp` against a local llama-server. Lattice ids carry an
 * `inkling:` prefix so they never collide with another provider's ids. There
 * is one model and no thinking level to pick.
 */

export interface InklingModelEntry {
  id: string;
  label: string;
  description: string;
}

export const INKLING_MODEL_PREFIX = 'inkling:';

export const INKLING_MODELS: InklingModelEntry[] = [
  { id: 'inkling:inkling-2-mini', label: 'Inkling 2 Mini (Local)', description: 'Runs on this computer; reads text, not images' },
];

export const DEFAULT_INKLING_MODEL_ID = 'inkling:inkling-2-mini';

export function inklingModelEntry(model: string | null | undefined): InklingModelEntry | undefined {
  return model ? INKLING_MODELS.find((m) => m.id === model) : undefined;
}
