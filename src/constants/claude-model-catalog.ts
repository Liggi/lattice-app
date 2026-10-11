import { supersededModelRefusal } from './superseded-models.js';

/** One model as the Claude CLI's `initialize` handshake lists it. */
export interface ClaudeCliModel {
  value: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
}

/** A model the sign-in can use, as the model menus offer it. */
export interface ClaudeCatalogModel {
  id: string;
  label: string;
  description?: string;
  /** Listed under the menu's collapsed "Other models" row. */
  other: boolean;
}

export type ClaudeModelCatalog =
  | { source: 'cli'; models: ClaudeCatalogModel[]; defaultModel: string | null }
  | { source: 'unavailable'; error: string };

const CLI_ALIASES = new Set(['default', 'opus', 'sonnet', 'haiku', 'fable', 'opusplan']);

function baseId(id: string): string {
  return id.replace(/\[[^\]]*\]$/, '');
}

function family(id: string): string {
  return baseId(id).split('-')[1] ?? id;
}

/**
 * The menu's list from what the CLI says this sign-in can use. Each family's
 * newest model is what the CLI's own alias for it (opus, sonnet, …) resolves
 * to; those are the common list, and the family's older models go under
 * Other. A family the CLI lists with no alias is common as listed. Models
 * Lattice refuses as superseded are left out.
 */
export function catalogFromCliModels(cliModels: ClaudeCliModel[]): { models: ClaudeCatalogModel[]; defaultModel: string | null } {
  const aliasTargets = new Set<string>();
  let defaultModel: string | null = null;
  for (const model of cliModels) {
    if (!CLI_ALIASES.has(model.value) || !model.resolvedModel) continue;
    if (model.value === 'default') defaultModel = model.resolvedModel;
    else aliasTargets.add(baseId(model.resolvedModel));
  }
  const aliasedFamilies = new Set([...aliasTargets].map(family));

  const seen = new Set<string>();
  const models: ClaudeCatalogModel[] = [];
  for (const model of cliModels) {
    if (model.value === 'default') continue;
    const id = CLI_ALIASES.has(model.value) ? model.resolvedModel : model.value;
    if (!id || !id.startsWith('claude-') || seen.has(baseId(id)) || supersededModelRefusal(id)) continue;
    seen.add(baseId(id));
    models.push({
      id,
      label: model.displayName?.trim() || id,
      ...(model.description?.trim() ? { description: model.description.trim() } : {}),
      other: aliasedFamilies.has(family(id)) && !aliasTargets.has(baseId(id)),
    });
  }
  // Common models first, each group in the CLI's order.
  return { models: [...models.filter((m) => !m.other), ...models.filter((m) => m.other)], defaultModel };
}
