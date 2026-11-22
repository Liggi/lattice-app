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
 * that changes nothing adds nothing. A block that follows a change lists only
 * the decisions made or withdrawn since the last one; the full list comes on
 * the first block, after a compaction or switch, and every
 * `DECISIONS_REFRESH_EVERY` blocks. The event is not a note and not a worker
 * event, so it does not move `state.revision` and cannot make itself due.
 */

import { userName } from '../user-profile.js';
import { createLogger } from '../infrastructure/logger.js';
import { getHarnessSessionManager } from '../../harness/setup.js';
import { appendCustomHarnessEvent } from '../../harness/harness-custom-events.js';
import { iterateEventsNewestFirst } from '../../session-history/repository.js';
import { ConversationService } from './conversation-service.js';
import {
  renderProjectState, STORY_MAX_WORDS, STORY_STALE_AFTER_THREAD_CHANGES, type ProjectState,
} from '../../types/project-state.js';
import { readProjectState } from './project-state.js';
import { SERVER_NOTE_END, SERVER_NOTE_PREFIX } from '../../types/worker-events.js';

const logger = createLogger('ProjectOrientation');

export const PROJECT_ORIENTED_EVENT = 'project:oriented';

export interface ProjectOrientedData {
  /** The `revision` of the state that was shown. */
  revision: number;
  reason: OrientationReason;
  /**
   * Whether the block listed every decision in force or only the ones changed
   * since the revision shown before it. Absent on events written before the
   * split, which always listed them all.
   */
  decisions?: 'all' | 'changes';
  /**
   * Set when the block asked for the account of where the project stands to be
   * written or rewritten: the seq of the story it found stale, or 0 when there
   * was none. Each story is asked about once.
   */
  storyAsked?: number;
}

type OrientationReason = 'first' | 'changed' | 'compacted' | 'switched' | 'refresh' | 'resumed';

/**
 * After this many blocks that listed only the changed decisions, the next one
 * lists them all again, so a long stretch without a compaction does not leave
 * the full list only far back in the context.
 */
export const DECISIONS_REFRESH_EVERY = 20;

/**
 * Past this many decisions in force, a block that lists them all asks for them
 * to be merged or retired. It rides on the full list only, which is when the
 * coordinator has them in front of it, so it comes once per copy rather than
 * on every turn.
 */
export const DECISIONS_CONSOLIDATE_AT = 30;

/** Whether the coordinator has noted anything worth orienting from yet. */
function hasRecord(state: ProjectState): boolean {
  return Boolean(state.outcome) || state.story !== null || state.priority !== null
    || state.decisions.length > 0 || state.open.length > 0 || state.attention.length > 0;
}

interface OrientationDue {
  reason: OrientationReason;
  /** The revision last shown, when the decisions can be given as changes since it. */
  since?: number;
}

/**
 * Why this turn needs the state in front of it, or null when it does not.
 *
 * A compaction counts even though the state has not changed: the session was
 * given the block and then had it summarised away, so as far as the turn is
 * concerned it never arrived. It wins over a change, because the turn after a
 * compaction needs the whole list again, not what moved since a copy it no
 * longer has.
 */
function orientationDue(conversationId: string, revision: number): OrientationDue | null {
  let compacted = false;
  let latest: Partial<ProjectOrientedData> | null = null;
  let changesSinceFull = 0;
  for (const event of iterateEventsNewestFirst(conversationId, [PROJECT_ORIENTED_EVENT, 'turn:end'])) {
    if (event.type === 'turn:end') {
      if (!latest && (event.data as { compact?: boolean })?.compact) compacted = true;
      continue;
    }
    const data = (event.data ?? {}) as Partial<ProjectOrientedData>;
    if (!latest) {
      latest = data;
      if (compacted) return { reason: 'compacted' };
      if (typeof data.revision === 'number' && revision <= data.revision) return null;
      if (typeof data.revision !== 'number') return { reason: 'changed' };
    }
    if (data.decisions !== 'changes') break;
    changesSinceFull += 1;
  }
  if (!latest) return { reason: 'first' };
  if (changesSinceFull >= DECISIONS_REFRESH_EVERY) return { reason: 'refresh' };
  return { reason: 'changed', since: latest.revision };
}

/** Whether the account of where the project stands is missing or behind the threads, by the same rule either way. */
function storyBehind(state: ProjectState): boolean {
  if (state.story) {
    return state.story.closedSince > 0 || state.story.changedSince >= STORY_STALE_AFTER_THREAD_CHANGES;
  }
  return state.closed.length > 0 || state.open.length + state.closed.length >= STORY_STALE_AFTER_THREAD_CHANGES;
}

/** Whether a block since that story was written already asked about it. */
function storyAlreadyAsked(conversationId: string, storySeq: number): boolean {
  for (const event of iterateEventsNewestFirst(conversationId, [PROJECT_ORIENTED_EVENT])) {
    if (event.seq < storySeq) return false;
    if ((event.data as Partial<ProjectOrientedData> | null)?.storyAsked === storySeq) return true;
  }
  return false;
}

function storyAsk(state: ProjectState, cli: string, conversationId: string): string[] {
  const how = `\`${cli} session note ${conversationId} --story "<text>"\``;
  const what = `four short lines, \`Aim:\`, \`Learned:\`, \`Now:\` and \`Next:\`, in ${userName()}'s words, at most ${STORY_MAX_WORDS} words in all`;
  if (!state.story) {
    return [`[This project has no account of where it stands yet. Write one with ${how}: ${what}. It is what ${userName()} reads in the panel and what you give them when they ask where things are.]`, ''];
  }
  const closed = state.story.closedSince;
  const changed = state.story.changedSince;
  const parts = [
    ...(closed > 0 ? [`${closed} thread${closed === 1 ? '' : 's'} closed`] : []),
    ...(changed > 0 ? [`${changed} other thread change${changed === 1 ? '' : 's'}`] : []),
  ];
  return [`[The account of where the project stands was written before ${parts.join(' and ')}. If it no longer says where things are, replace it with ${how}: ${what}. This is asked once for each account.]`, ''];
}

function consolidationAsk(state: ProjectState, cli: string, conversationId: string): string[] {
  const count = state.decisions.length;
  if (count <= DECISIONS_CONSOLIDATE_AT) return [];
  return [
    `[${count} decisions are in force. A list this long is not read closely, and every new one makes the rest easier to miss.`,
    'When the work in this turn allows, merge the ones that say the same thing into one',
    `(\`${cli} session note ${conversationId} --decide "<the merged rule>" --replaces <seq>,<seq>\`) and retire the ones that no`,
    `longer bind (\`--retire <seq>,<seq> --with "<why>"\`), until about ${DECISIONS_CONSOLIDATE_AT} remain. This is asked when you are shown the full list, not on every turn.]`,
    '',
  ];
}

/**
 * The block to put in front of a project session's next input, or '' when it
 * already has the current state. Records the injection.
 */
export function buildProjectOrientation(conversationId: string, cli: string, opts: { resumed?: boolean } = {}): string {
  const block = composeProjectOrientation(conversationId, cli, opts);
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
  opts: { switched?: boolean; resumed?: boolean } = {},
): { text: string; shown: ProjectOrientedData } | null {
  const conversation = ConversationService.getInstance().getConversation(conversationId);
  if (!conversation?.coordinator) return null;
  const state = readProjectState(conversationId);
  if (!hasRecord(state)) return null;
  const due: OrientationDue | null = opts.switched ? { reason: 'switched' } : orientationDue(conversationId, state.revision);
  if (!due) return null;
  // A cold resume respawns the process. Its context comes back from the
  // provider's transcript, if at all, so it gets the whole list rather than
  // changes to a copy it may not have; it gets nothing when nothing moved.
  const { reason, since } = opts.resumed && due.since !== undefined ? { reason: 'resumed' as const, since: undefined } : due;

  const storySeq = state.story?.seq ?? 0;
  const askStory = storyBehind(state) && !storyAlreadyAsked(conversationId, storySeq);

  const opening = reason === 'compacted'
    ? 'Your context was just compacted; this is the project as the record has it, not as the summary left it.'
    : reason === 'first' || reason === 'switched' || reason === 'resumed'
      ? 'This is the project as the record has it.'
      : reason === 'refresh'
        ? 'This is the project as the record has it, decisions and all, since the full list was last shown many turns ago.'
        : 'The project record has moved since you last saw it. This is where it stands now; the decisions are given as what changed.';
  const text = [
    `${SERVER_NOTE_PREFIX} ${opening} It is what you decide from; your context is not the record.`,
    `Keep it current as you go (\`${cli} session note ${conversationId} …\`), and read what it points to rather than working from memory of it.]`,
    '',
    renderProjectState(state, { cli, conversationId, userName: userName(), now: Date.now(), decisionsSince: since }),
    '',
    ...(since === undefined ? consolidationAsk(state, cli, conversationId) : []),
    ...(askStory ? storyAsk(state, cli, conversationId) : []),
    SERVER_NOTE_END,
    '',
  ].join('\n');
  return {
    text,
    shown: {
      revision: state.revision, reason, decisions: since === undefined ? 'all' : 'changes',
      ...(askStory ? { storyAsked: storySeq } : {}),
    },
  };
}

/** The `project:oriented` receipt for a block that was shown. */
export function recordProjectOrientation(conversationId: string, shown: ProjectOrientedData): void {
  const manager = getHarnessSessionManager();
  if (manager) appendCustomHarnessEvent(manager, conversationId, PROJECT_ORIENTED_EVENT, shown);
  logger.info('Project orientation', { conversationId, revision: shown.revision, reason: shown.reason, decisions: shown.decisions });
}
