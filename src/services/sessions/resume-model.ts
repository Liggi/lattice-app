import { DEFAULT_CODEX_MODEL_ID } from '@/constants/codex-models.js';
import { ConversationService, type Provider } from '@/services/sessions/conversation-service.js';

interface ResolveResumeModelParams {
  provider: Provider;
  requestedModel?: string;
  storedModel?: string | null;
}

function normalizeModel(model: string | null | undefined): string | undefined {
  const normalized = model?.trim();
  return normalized && normalized !== 'unknown' ? normalized : undefined;
}

/**
 * Keep an existing conversation on its stored model unless the caller
 * explicitly requests a switch. Legacy Claude segments can contain the
 * sentinel "unknown"; those continue to defer to Claude's configured default.
 */
export function resolveResumeModel({
  provider,
  requestedModel,
  storedModel,
}: ResolveResumeModelParams): string | undefined {
  const requested = normalizeModel(requestedModel);
  if (requested) {
    return requested;
  }

  const stored = normalizeModel(storedModel);
  if (stored) {
    return stored;
  }

  return provider === 'codex' ? DEFAULT_CODEX_MODEL_ID : undefined;
}

/**
 * The model a process replacement should run on, for the harness routes that
 * have no conversation handle of their own. Same rule as a lifecycle resume:
 * an explicit request wins, otherwise the conversation stays on what it is
 * actually running at, which `run:ready` writes onto the segment each run.
 *
 * Without this, a cold recovery passed no `--model` at all and the CLI fell
 * back to the account default — which is how a worker dispatched on
 * claude-fable-5-1 came back as claude-opus-5[1m] after a resume. A legacy segment still reading "unknown" keeps
 * deferring to Claude's own configured default rather than guessing one.
 */
export function currentResumeModel(
  conversationId: string,
  provider: Provider,
  requestedModel?: string,
): string | undefined {
  const segment = ConversationService.getInstance().getLatestSegment(conversationId);
  return resolveResumeModel({
    provider,
    requestedModel,
    storedModel: segment?.provider === provider ? segment.model : null,
  });
}
