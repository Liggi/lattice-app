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

const FAMILY_RANK: Record<string, number> = {
  fable: 0,
  opus: 1,
  sonnet: 2,
  haiku: 3,
};

function claudeVersion(id: string): [number, number] {
  const parts = baseId(id).split('-').slice(2);
  const major = /^\d+$/.test(parts[0] ?? '') ? Number(parts[0]) : 0;
  // Treat 8-digit release dates (e.g. 20251001) as not a minor version.
  const minor = /^\d{1,2}$/.test(parts[1] ?? '') ? Number(parts[1]) : 0;
  return [major, minor];
}

/**
 * Orders Claude models by capability (Fable → Opus → Sonnet → Haiku), newest
 * version first within each family, with common models before older ones.
 */
export function sortClaudeCatalogModels(models: ClaudeCatalogModel[]): ClaudeCatalogModel[] {
  return [...models].sort((a, b) => {
    const otherDiff = Number(a.other) - Number(b.other);
    if (otherDiff !== 0) return otherDiff;
    const rankA = FAMILY_RANK[family(a.id)] ?? 99;
    const rankB = FAMILY_RANK[family(b.id)] ?? 99;
    if (rankA !== rankB) return rankA - rankB;
    const [majA, minA] = claudeVersion(a.id);
    const [majB, minB] = claudeVersion(b.id);
    if (majA !== majB) return majB - majA;
    if (minA !== minB) return minB - minA;
    return 0;
  });
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
  return { models: sortClaudeCatalogModels(models), defaultModel };
}
