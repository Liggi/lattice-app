import { useQuery } from '@tanstack/react-query';
import { parseJson } from '../../../utils/json.js';
import { CLAUDE_MODELS } from '@/constants/claude-models';
import { sortClaudeCatalogModels, type ClaudeCatalogModel, type ClaudeModelCatalog } from '@/constants/claude-model-catalog';

/**
 * Lattice's own list, offered only when the CLI could not be asked (none
 * installed, or it failed); the server logs why.
 */
const REGISTRY_MODELS: ClaudeCatalogModel[] = sortClaudeCatalogModels(
  CLAUDE_MODELS
    .filter((model) => model.composerSelectable)
    .map((model) => ({ id: model.id, label: model.label, description: model.description, other: model.other === true })),
);

export interface ClaudeModels {
  models: ClaudeCatalogModel[];
  /** The model the CLI runs when none is named, when it said. */
  cliDefaultModel: string | null;
  /** Set when the CLI could not be asked and the built-in list is shown. */
  note?: string;
}

/**
 * The CLI names a model by family ("Opus") and opens its description with the
 * full name ("Opus 5.5 · Best for…"); the menus show the full name.
 */
function withVersionedLabel(model: ClaudeCatalogModel): ClaudeCatalogModel {
  const [head, ...rest] = (model.description ?? '').split(' · ');
  if (!head.startsWith(`${model.label} `)) return model;
  return { ...model, label: head, description: rest.join(' · ') || undefined };
}

const FALLBACK_NOTE = "Couldn't check your sign-in's models; showing the built-in list";

/** The Claude models every model menu offers: the ones this sign-in can use. */
export function useClaudeModels(): ClaudeModels {
  const { data, isError } = useQuery({
    queryKey: ['claude-models'],
    queryFn: async (): Promise<ClaudeModelCatalog> => {
      const response = await fetch('/api/provider-auth/claude/models');
      if (!response.ok) throw new Error(`/api/provider-auth/claude/models: HTTP ${response.status}`);
      return parseJson(await response.text()) as ClaudeModelCatalog;
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
  return data?.source === 'cli'
    ? { models: sortClaudeCatalogModels(data.models.map(withVersionedLabel)), cliDefaultModel: data.defaultModel }
    : { models: REGISTRY_MODELS, cliDefaultModel: null, ...(data || isError ? { note: FALLBACK_NOTE } : {}) };
}
