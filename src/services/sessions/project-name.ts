/**
 * A project's sidebar title, written from the outcome its coordinator has
 * agreed with the user.
 *
 * The problem this exists to fix: a project rendered with the same title logic
 * as an ordinary session, and that logic re-reads the transcript every turn. So
 * a project's name tracked whatever task was in flight. The Lattice project was
 * called "Orient on Lattice restyle project state" at 19:01 on 21 September and
 * "Simplify app UI and clean up sidebar/header" at 19:15, while the outcome it
 * had agreed — own the ongoing development of Lattice orchestrator and the
 * restyled app — never moved.
 *
 * So the outcome is the only input, and an outcome note is the only trigger.
 * Nothing here runs on progress: closing a thread, dispatching a worker or
 * finishing a task cannot rename a project, because none of them says the
 * project is now for something else. The bill is one Haiku call each time
 * someone decides the project's purpose has changed.
 *
 * A user-typed name always wins, and it wins at read time rather than by this
 * module checking before it writes. The two live in different columns, so a
 * generation that started before a rename and finished after it lands in
 * `project_name` and is simply never displayed. There is no window in which
 * the race can be lost.
 */

import { createLogger } from '../infrastructure/logger.js';
import { allowGeneration } from '../infrastructure/generation-gates.js';
import { anthropicService, normalizeProjectName } from '../insights/anthropic-service.js';
import { SessionInfoService } from './session-info-service.js';
import { ConversationService } from './conversation-service.js';

const logger = createLogger('ProjectName');

/**
 * One generation per project at a time. The backfill path is reached from a
 * route the right-hand panel refetches on every worker event, so without this
 * a project with no name yet would start a call on each of them.
 */
const inFlight = new Set<string>();

/**
 * The newest outcome asked for while a call was already running, per project.
 *
 * Without it, a second outcome arriving mid-call was simply dropped, the first
 * one's name was stored, and backfill then saw a name and never looked again —
 * leaving the project permanently titled after an outcome it had already moved
 * on from. The running call drains this, so the last outcome anyone asked for
 * is the one the project ends up with.
 */
const pendingOutcome = new Map<string, string>();

/**
 * Bumped each time a coordinator names its project. A generation that started
 * before the bump is for an outcome the coordinator has since named, so its
 * result is thrown away rather than written over the coordinator's name.
 */
const coordinatorNamings = new Map<string, number>();

/**
 * Read the title a project should display, ignoring any user-typed name.
 * Callers that render decide between this and `custom_name`; this only reports
 * what was generated.
 */
export async function readProjectName(coordinatorConversationId: string): Promise<string | null> {
  const info = await SessionInfoService.getInstance().getSessionInfo(coordinatorConversationId);
  return info.project_name?.trim() || null;
}

/**
 * Generate and store a project's name from `outcome`.
 *
 * Returns the stored name, or null when anything declined to produce one — the
 * gate is off, no API key is configured, another call is already running and
 * has taken this outcome over, or the model returned something unusable. Every
 * one of those leaves the project with no generated name, which renders as the
 * session mission exactly as it did before this existed.
 *
 * A name is stored only once nothing newer is waiting. A result for an outcome
 * that has since been superseded is thrown away rather than written, so no
 * failure of the newer call can strand the project on the older name: the field
 * stays empty and backfill tries again.
 */
export async function generateProjectName(
  coordinatorConversationId: string,
  outcome: string,
): Promise<string | null> {
  const trimmedOutcome = outcome.trim();
  if (!trimmedOutcome) return null;
  if (!allowGeneration('projectName')) return null;
  if (inFlight.has(coordinatorConversationId)) {
    // Hand the outcome to the running call rather than dropping it.
    pendingOutcome.set(coordinatorConversationId, trimmedOutcome);
    logger.debug('Newer outcome handed to the running generation', {
      coordinator: coordinatorConversationId,
      outcome: trimmedOutcome,
    });
    return null;
  }

  inFlight.add(coordinatorConversationId);
  const namingAtStart = coordinatorNamings.get(coordinatorConversationId) ?? 0;
  try {
    let current = trimmedOutcome;
    for (;;) {
      pendingOutcome.delete(coordinatorConversationId);
      const name = await anthropicService.generateProjectName(current, coordinatorConversationId);

      const newer = pendingOutcome.get(coordinatorConversationId);
      if (newer !== undefined && newer !== current) {
        logger.debug('Discarding a name for a superseded outcome', {
          coordinator: coordinatorConversationId,
          superseded: current,
          newer,
        });
        current = newer;
        continue;
      }

      if (!name) return null;
      if ((coordinatorNamings.get(coordinatorConversationId) ?? 0) !== namingAtStart) {
        logger.debug('Discarding a generated name; the coordinator has named the project', {
          coordinator: coordinatorConversationId,
        });
        return null;
      }
      await SessionInfoService.getInstance().updateSessionInfo(coordinatorConversationId, {
        project_name: name,
      });
      logger.info('Project named', { coordinator: coordinatorConversationId, name, outcome: current });
      return name;
    }
  } catch (error) {
    logger.debug('Project name generation failed', {
      coordinator: coordinatorConversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    pendingOutcome.delete(coordinatorConversationId);
    inFlight.delete(coordinatorConversationId);
  }
}

/**
 * Store the name a coordinator wrote with its outcome. This is how a project
 * gets a short name with no API key: the coordinator has just agreed the
 * purpose, so it is already the best-placed thing to name it. Lands in
 * `project_name` like a generated name, so a user-typed name still wins.
 */
async function storeCoordinatorName(coordinatorConversationId: string, raw: string): Promise<boolean> {
  const name = normalizeProjectName(raw);
  if (!name) {
    logger.debug('Coordinator project name unusable', { coordinator: coordinatorConversationId, raw });
    return false;
  }
  coordinatorNamings.set(coordinatorConversationId, (coordinatorNamings.get(coordinatorConversationId) ?? 0) + 1);
  await SessionInfoService.getInstance().updateSessionInfo(coordinatorConversationId, { project_name: name });
  logger.info('Project named by its coordinator', { coordinator: coordinatorConversationId, name });
  return true;
}

/**
 * The outcome changed, so the name changes with it: to the coordinator's name
 * when it gave one, otherwise to a generated one. Called from the note append
 * path with the outcome recorded *before* the new note, so an outcome restated
 * in the same words spends nothing and renames nothing — except that a
 * project with no name yet takes the coordinator's.
 *
 * Fire-and-forget: naming a project is not worth making anyone's turn wait, and
 * a failure has to be survivable anyway.
 */
export function onProjectOutcomeChanged(
  coordinatorConversationId: string,
  previousOutcome: string | null,
  nextOutcome: string,
  coordinatorName?: string,
): void {
  void (async () => {
    if (previousOutcome !== null && previousOutcome.trim() === nextOutcome.trim()) {
      if (coordinatorName && !(await readProjectName(coordinatorConversationId))) {
        await storeCoordinatorName(coordinatorConversationId, coordinatorName);
        return;
      }
      logger.debug('Outcome restated unchanged; keeping the existing name', {
        coordinator: coordinatorConversationId,
      });
      return;
    }
    if (coordinatorName && await storeCoordinatorName(coordinatorConversationId, coordinatorName)) return;
    await generateProjectName(coordinatorConversationId, nextOutcome);
  })().catch((error: unknown) => {
    logger.debug('Project naming failed', {
      coordinator: coordinatorConversationId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * Name a project that has an outcome but no name yet.
 *
 * Every project that existed before this feature is in that state, and so is
 * any project whose naming call failed. Reached from the project-state route,
 * which is coordinator-only and already holds the folded state, so it costs a
 * lookup rather than a scan. Does nothing once a name exists.
 */
export async function backfillProjectName(
  coordinatorConversationId: string,
  outcome: string | null,
): Promise<void> {
  if (!outcome?.trim()) return;
  if (inFlight.has(coordinatorConversationId)) return;
  if (!ConversationService.getInstance().getConversation(coordinatorConversationId)?.coordinator) return;
  if (await readProjectName(coordinatorConversationId)) return;

  await generateProjectName(coordinatorConversationId, outcome);
}

/** Test seam: the in-flight guard outlives a single test otherwise. */
export function __resetProjectNameGuardsForTests(): void {
  inFlight.clear();
  pendingOutcome.clear();
  coordinatorNamings.clear();
}
