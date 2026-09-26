/**
 * Server-side writer and reader for a coordinator's project state. Shapes
 * and the fold live in `src/types/project-state.ts` (shared with the web
 * client); this is the only file that touches the harness for it.
 *
 * The nudge: a coordinator turn that left the record behind gets one line in
 * front of its next input. Either it dispatched or answered a worker and
 * noted nothing, or it ended with a worker's report or question still owed a
 * disposition. It is recorded as a `project:nudged` event so the count is
 * visible (`GET /api/conv/:id/project`) — the discipline has to be seen to
 * hold before anything else answers from this state.
 */

import { getHarnessSessionManager } from '../../harness/setup.js';
import { appendCustomHarnessEvent } from '../../harness/harness-custom-events.js';
import { createLogger } from '../infrastructure/logger.js';
import { getEvents } from '../../session-history/repository.js';
import { ConversationService } from './conversation-service.js';
import {
  PROJECT_NOTED_EVENT,
  PROJECT_NUDGED_EVENT,
  PROJECT_FOLD_EVENT_TYPES,
  foldProjectState,
  unaddressedAfterTurn,
  type ProjectNotedData,
  type ProjectState,
} from '../../types/project-state.js';
import { SERVER_NOTE_END, SERVER_NOTE_PREFIX } from '../../types/worker-events.js';
import { onProjectOutcomeChanged } from './project-name.js';

const logger = createLogger('ProjectState');

/** How many waiting events the nudge names before it falls back to counting them. */
const NUDGE_ITEMS = 3;

export function readProjectState(coordinatorConversationId: string): ProjectState {
  return foldProjectState(getEvents(coordinatorConversationId, { types: [...PROJECT_FOLD_EVENT_TYPES] }));
}

/** Append one note to the coordinator's log. Returns the event seq (the id an `open` note is closed by), or null. */
export function appendProjectNote(coordinatorConversationId: string, data: ProjectNotedData): number | null {
  const manager = getHarnessSessionManager();
  if (!manager) {
    logger.warn('No harness session manager; project note dropped', { coordinator: coordinatorConversationId, kind: data.kind });
    return null;
  }
  // Read before appending: the project's name is regenerated when its outcome
  // actually changes, so the comparison needs the outcome this note replaces.
  const previousOutcome = data.kind === 'outcome'
    ? foldProjectState(getEvents(coordinatorConversationId)).outcome
    : null;
  const appended = appendCustomHarnessEvent(manager, coordinatorConversationId, PROJECT_NOTED_EVENT, data);
  if (!appended) {
    logger.warn('Project note not appended', { coordinator: coordinatorConversationId, kind: data.kind });
    return null;
  }
  // Only an outcome note reaches this. Progress notes — update, close, now,
  // priority — deliberately do not rename a project; that they could is the
  // whole defect this replaces.
  if (data.kind === 'outcome') {
    onProjectOutcomeChanged(coordinatorConversationId, previousOutcome, data.text, data.name);
  }
  return appended.seq;
}

/**
 * The line to put in front of a coordinator's next input when its last turn
 * left the record behind; empty otherwise. Records the nudge.
 *
 * Two cases. The turn changed the roster and wrote no note at all — the
 * original check. And the turn ended with a worker's report or question,
 * one that was already waiting when the turn began, still owed a
 * disposition: the case a `--now` note used to satisfy, which is how a
 * finding could be delivered, acknowledged and dropped. The second names
 * the events, so answering it is a command rather than a hunt.
 */
export function buildProjectStateNudge(coordinatorConversationId: string, cli: string): string {
  const conversation = ConversationService.getInstance().getConversation(coordinatorConversationId);
  if (!conversation?.coordinator) return '';
  const { stale, pending, unnoted } = unaddressedAfterTurn(getEvents(coordinatorConversationId));
  if (!stale) return '';
  const manager = getHarnessSessionManager();
  if (manager) appendCustomHarnessEvent(manager, coordinatorConversationId, PROJECT_NUDGED_EVENT, {});
  logger.info('Project state nudge', {
    coordinator: coordinatorConversationId,
    unnoted,
    pending: pending.map((item) => item.seq),
  });

  const lines: string[] = [];
  if (pending.length > 0) {
    // A coordinator that predates this record has every report it ever
    // received waiting at once — dozens, on a long-running one — and a nudge
    // naming all of them is a wall nobody works through. Name the newest few
    // and count the rest; `session state` has the whole list.
    const newest = pending.slice(-NUDGE_ITEMS);
    const older = pending.length - newest.length;
    const listed = newest.map((item) => `[${item.seq}] the ${item.kind} from ${item.worker}`).join(', ');
    lines.push(
      `${SERVER_NOTE_PREFIX} Still waiting on you to say what it changed: ${listed}`
        + (older > 0 ? `, and ${older} older (\`${cli} session state ${coordinatorConversationId}\` lists them).` : '.'),
      `Say it on the thread it belongs to (\`${cli} session note ${coordinatorConversationId} --thread <id> --next "…" --addresses <seq>\`),`,
      `close that thread with the evidence, or answer the question (\`${cli} session send <worker> --from ${coordinatorConversationId} --answers <seq> --summary "…" --message "…"\`).`,
      'Deciding it needs nothing is a disposition too — record it and move on.]',
    );
  } else {
    lines.push(
      `${SERVER_NOTE_PREFIX} Your last turn dispatched or answered a worker and left the project state untouched.`,
      `Note what changed first (\`${cli} session note ${coordinatorConversationId} --decide/--open/--thread/--close/--now …\`), then act on the message below.]`,
    );
  }
  lines.push(SERVER_NOTE_END, '');
  return lines.join('\n');
}
