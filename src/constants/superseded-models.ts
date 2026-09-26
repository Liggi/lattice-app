import { getClaudeModel } from './claude-models.js';
import { getCodexModel } from './codex-models.js';

/**
 * Why `model` may not start, resume or switch a session, or null if it may.
 * Refused rather than upgraded so the caller learns its instruction is stale.
 */
export function supersededModelRefusal(model: string | null | undefined): string | null {
  const id = model?.trim().replace(/\[[^\]]*\]$/, '');
  if (!id) return null;
  const replacement = getClaudeModel(id)?.supersededBy ?? getCodexModel(id)?.supersededBy;
  return replacement ? `${id} is superseded: use ${replacement} instead.` : null;
}
