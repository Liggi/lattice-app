/**
 * The project session's orientation: the active project state, put in front
 * of a turn so the session acts on the record rather than on whatever its
 * context still holds.
 *
 * One projection, four paths. An ordinary message from the user, a worker's
 * report drained from the inbox, a cold resume after the process died, and
 * the input after a compaction all go through this, and all get the same
 * text — `renderProjectState`, active half only. Before this, the state
 * reached a turn only after a compaction (the restore block) or when the
 * previous turn had left something unaccounted for (the nudge), so an
 * ordinary turn ran on context alone and a resumed one on nothing.
 *
 * It is not repeated for the sake of it. Each injection records a
 * `project:oriented` event carrying the revision it showed, and the next turn
 * gets the block again only when the state has moved since, or when a
 * compaction has thrown away the copy the session was given. A back-and-forth
 * that changes nothing adds nothing. The event is not a note and not a worker
 * event, so it does not move `state.revision` and cannot make itself due.
 */

import { userName } from '../user-profile.js';
import { createLogger } from '../infrastructure/logger.js';
import { getHarnessSessionManager } from '../../harness/setup.js';
import { appendCustomHarnessEvent } from '../../harness/harness-custom-events.js';
import { getEvents } from '../../session-history/repository.js';
import type { RawEvent } from '../../session-history/types.js';
import { ConversationService } from './conversation-service.js';
import { foldProjectState, renderProjectState, type ProjectState } from '../../types/project-state.js';
import { SERVER_NOTE_END, SERVER_NOTE_PREFIX } from '../../types/worker-events.js';

const logger = createLogger('ProjectOrientation');

export const PROJECT_ORIENTED_EVENT = 'project:oriented';

export interface ProjectOrientedData {
  /** The `revision` of the state that was shown. */
  revision: number;
  reason: OrientationReason;
}

type OrientationReason = 'first' | 'changed' | 'compacted' | 'switched';

/** Whether the coordinator has noted anything worth orienting from yet. */
function hasRecord(state: ProjectState): boolean {
  return Boolean(state.outcome) || state.priority !== null
    || state.decisions.length > 0 || state.open.length > 0 || state.attention.length > 0;
}

/**
 * Why this turn needs the state in front of it, or null when it does not.
 *
 * A compaction counts even though the state has not changed: the session was
 * given the block and then had it summarised away, so as far as the turn is
 * concerned it never arrived.
 */
function orientationReason(events: readonly RawEvent[], revision: number): OrientationReason | null {
  let lastOriented = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === PROJECT_ORIENTED_EVENT) { lastOriented = i; break; }
  }
  if (lastOriented < 0) return 'first';
  const shown = (events[lastOriented].data as Partial<ProjectOrientedData>)?.revision;
  if (typeof shown !== 'number' || revision > shown) return 'changed';
  for (const event of events.slice(lastOriented + 1)) {
    if (event.type === 'turn:end' && (event.data as { compact?: boolean })?.compact) return 'compacted';
  }
  return null;
}

/**
 * The block to put in front of a project session's next input, or '' when it
 * already has the current state. Records the injection.
 */
export function buildProjectOrientation(conversationId: string, cli: string): string {
  const block = composeProjectOrientation(conversationId, cli);
  if (!block) return '';
  recordProjectOrientation(conversationId, block.shown);
  return block.text;
}

/**
 * The orientation text without recording it, for a caller that records it
 * only once the text has reached the model (coordinator-switch.ts). A model
 * taking the conversation over from another provider was shown nothing,
 * whatever the log says the previous one was shown, so `switched` always
 * produces the block.
 */
export function composeProjectOrientation(
  conversationId: string,
  cli: string,
  opts: { switched?: boolean } = {},
): { text: string; shown: ProjectOrientedData } | null {
  const conversation = ConversationService.getInstance().getConversation(conversationId);
  if (!conversation?.coordinator) return null;
  const events = getEvents(conversationId);
  const state = foldProjectState(events);
  if (!hasRecord(state)) return null;
  const reason = opts.switched ? 'switched' : orientationReason(events, state.revision);
  if (!reason) return null;

  const opening = reason === 'compacted'
    ? 'Your context was just compacted; this is the project as the record has it, not as the summary left it.'
    : reason === 'first' || reason === 'switched'
      ? 'This is the project as the record has it.'
      : 'The project record has moved since you last saw it. This is where it stands now.';
  const text = [
    `${SERVER_NOTE_PREFIX} ${opening} It is what you decide from; your context is not the record.`,
    `Keep it current as you go (\`${cli} session note ${conversationId} …\`), and read what it points to rather than working from memory of it.]`,
    '',
    renderProjectState(state, { cli, conversationId, userName: userName(), now: Date.now() }),
    '',
    SERVER_NOTE_END,
    '',
  ].join('\n');
  return { text, shown: { revision: state.revision, reason } };
}

/** The `project:oriented` receipt for a block that was shown. */
export function recordProjectOrientation(conversationId: string, shown: ProjectOrientedData): void {
  const manager = getHarnessSessionManager();
  if (manager) appendCustomHarnessEvent(manager, conversationId, PROJECT_ORIENTED_EVENT, shown);
  logger.info('Project orientation', { conversationId, revision: shown.revision, reason: shown.reason });
}
