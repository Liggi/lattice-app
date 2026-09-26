/**
 * Which session answers a question asked inside an article.
 *
 * Three candidates, in order:
 *
 *  1. The article's own `created_by_conv` — the session that drew the node. It
 *     already has the context the article came out of, so a question about the
 *     article lands where the reasoning behind it lives.
 *  2. The map's `default_conv` — for articles with no provenance (hand-written,
 *     or drawn by a session whose id was never recorded).
 *  3. A new conversation, saved back as the map's `default_conv` so the next
 *     provenance-less ask joins it instead of spawning another session.
 *
 * Pure over injected effects: the caller supplies the create and save
 * functions, so the ordering rule can be tested without a server.
 */

export interface ResponderDeps {
  /** The article's `created_by_conv`. */
  articleConv: string | null;
  /** The map's `default_conv`. */
  mapDefaultConv: string | null;
  /**
   * Creates a conversation with `firstMessage` as its opening prompt and
   * resolves to the new `conv-*` id. Creation and first send are one call in
   * this app (`POST /api/conv/create`), which is why the message is passed in
   * here rather than sent separately afterwards.
   */
  createConversation: (firstMessage: string) => Promise<string>;
  /** Persists the new conversation as the map's default responder. */
  saveMapDefault: (conversationId: string) => Promise<void>;
}

export interface ResponderResolution {
  conversationId: string;
  /**
   * True when the ask message was delivered as the new conversation's opening
   * prompt. The caller must not send it a second time.
   */
  deliveredWithCreate: boolean;
  /**
   * Set when the conversation was created but writing it back to the map
   * failed. Not fatal — the question is already on its way — but it means the
   * next ask will start yet another session, so the surface says so out loud
   * rather than quietly leaking sessions.
   */
  defaultSaveError: string | null;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export async function resolveResponder(
  deps: ResponderDeps,
  askMessage: string,
): Promise<ResponderResolution> {
  const existing = nonEmpty(deps.articleConv) ?? nonEmpty(deps.mapDefaultConv);
  if (existing) {
    return { conversationId: existing, deliveredWithCreate: false, defaultSaveError: null };
  }

  const conversationId = await deps.createConversation(askMessage);

  let defaultSaveError: string | null = null;
  try {
    await deps.saveMapDefault(conversationId);
  } catch (error) {
    defaultSaveError = error instanceof Error ? error.message : String(error);
  }

  return { conversationId, deliveredWithCreate: true, defaultSaveError };
}
