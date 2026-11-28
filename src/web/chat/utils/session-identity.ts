/**
 * Who a conversation is, as the view needs to know it: a coordinator, a
 * worker, or an ordinary session.
 *
 * Both facts have two possible sources. The sidebar's list row carries them
 * for every active conversation, but an archived conversation is not in that
 * list — and an archived worker is a normal destination, because a report
 * link stays clickable after the coordinator marks the worker done. The
 * details route answers for those, so each fact falls back to it.
 */

interface IdentityFields {
  coordinator?: boolean;
  pickedUpFrom?: string | null;
  archived?: boolean;
}

interface DetailsFields extends IdentityFields {
  sessionInfo?: { archived?: boolean };
  pickedUpFromCoordinator?: boolean;
}

/**
 * The coordinator this conversation was picked up from, or null if it is not a
 * worker. Being picked up from an ordinary session does not make it one: a
 * project started from a plain session is still a project. The parent's list
 * row says whether it is a coordinator; an archived parent has none, so the
 * details route answers. Until either does, a coordinator is taken to be a
 * project and anything else a worker.
 */
export function resolveParentConversationId(
  summary: IdentityFields | null | undefined,
  details: DetailsFields | null | undefined,
  parent?: IdentityFields | null,
): string | null {
  const parentId = summary?.pickedUpFrom ?? details?.pickedUpFrom ?? null;
  if (!parentId) return null;
  const parentIsCoordinator = parent?.coordinator ?? details?.pickedUpFromCoordinator
    ?? !(summary?.coordinator || details?.coordinator);
  return parentIsCoordinator ? parentId : null;
}

/** True when this conversation dispatches workers of its own. */
export function resolveIsCoordinator(
  summary: IdentityFields | null | undefined,
  details: DetailsFields | null | undefined,
  workerCount: number,
): boolean {
  return Boolean(summary?.coordinator || details?.coordinator) || workerCount > 0;
}

/**
 * Whether the conversation is archived.
 *
 * The list row decides when it exists, including when it says false — an
 * active session that the details route has not caught up with must still
 * read as active. With no row, the details route's merged session info is
 * the answer, which is what makes an archived session's header offer Restore
 * rather than a second Archive that writes the state it is already in.
 */
export function resolveIsArchived(
  summary: IdentityFields | null | undefined,
  details: DetailsFields | null | undefined,
): boolean {
  return summary?.archived ?? details?.sessionInfo?.archived ?? false;
}

interface TitleDetails {
  sessionInfo?: { custom_name?: string | null; project_name?: string | null };
}

/**
 * The header's title. The list row's title wins when the row exists; an
 * archived or still-loading worker has none, so a name set on the session
 * comes next, then the task its project dispatched it with. Null only when
 * none of these is known.
 */
export function resolveSessionTitle(
  summaryTitle: string | null | undefined,
  details: TitleDetails | null | undefined,
  workerTask: string | null | undefined,
): string | null {
  return summaryTitle?.trim()
    || details?.sessionInfo?.custom_name?.trim()
    || details?.sessionInfo?.project_name?.trim()
    || workerTask?.trim()
    || null;
}
