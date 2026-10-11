/**
 * A plugin's confirm card: a `lattice ask` card put up by the plugin's server
 * code rather than by the agent, whose `runs` option calls the plugin's
 * handler (`decisions.ts`, `runAction`). The action is stored in the card's
 * event, so the card still works after a restart.
 */

import type { LatticeConfirmCard } from '@liggi/lattice-plugin-kit';
import { askDecision } from '@/services/sessions/decisions.js';

export function askPluginConfirm(
  plugin: string,
  conversationId: string,
  card: LatticeConfirmCard,
  action: { name: string; payload: unknown },
): { cardId: string; replaced: boolean } {
  const { id, replaced } = askDecision(
    conversationId,
    card.question,
    card.options.map((option) => ({ label: option.label, consequence: option.consequence, recommended: option.recommended === true })),
    undefined,
    { detail: card.detail, action: { plugin, name: action.name, payload: action.payload, runs: card.runs } },
  );
  return { cardId: id, replaced: replaced !== null };
}
