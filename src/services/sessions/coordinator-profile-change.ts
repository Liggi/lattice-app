/**
 * Moving a running coordinator onto another profile, and back.
 *
 * A coordinator's profile is normally fixed when it is created. This is the
 * deliberate exception, for a coordinator someone chose to move: it records
 * the new profile, switches front's model only when the profile names a
 * different one, and logs the change as a `coordinator:profile` event. That
 * event is what makes a revert exact (the profile and model before it) and
 * what tells the next input to carry the rebuilt preamble, so the new routing
 * reaches front on its next turn instead of at its next compaction.
 */

import type { SessionManager } from '@liggi/agent-ui-harness/server';
import { appendCustomHarnessEvent } from '../../harness/harness-custom-events.js';
import { getEvents } from '../../session-history/repository.js';
import type { RawEvent } from '../../session-history/types.js';
import { antigravityModelId } from '../../constants/antigravity-models.js';
import { findProfile, profileForRecorded, type ProfileSettings } from '../../constants/coordinator-profiles.js';
import type { ConversationService } from './conversation-service.js';
import type { SwitchResult } from './coordinator-switch.js';
import type { SwitchTarget } from './coordinator-switch-state.js';

export const COORDINATOR_PROFILE_EVENT = 'coordinator:profile';

export interface CoordinatorProfileData {
  /** The recorded profile before the change; null is a coordinator from before profiles, read as "opus". */
  from: string | null;
  to: string | null;
  /** Front's model before and after, when the change switched it. */
  switched?: { from: SwitchTarget; to: SwitchTarget };
  /** The seq of the change this one undoes. */
  reverts?: number;
}

export type ProfileChangeResult =
  | { status: 'changed'; conversationId: string; from: string; to: string; switched?: { from: SwitchTarget; to: SwitchTarget }; reverted?: number }
  | { status: 'unchanged'; conversationId: string; profile: string }
  | { status: 'refused'; code: string; reason: string };

export interface ProfileChangeDeps {
  sessionManager: SessionManager;
  conversationService: ConversationService;
  settings: ProfileSettings | undefined;
  /** Moves front to another model (coordinator-switch.ts). */
  switchTo: (target: SwitchTarget) => Promise<SwitchResult>;
}

const refused = (code: string, reason: string): ProfileChangeResult => ({ status: 'refused', code, reason });

/** The profile changes still in force, oldest first: every change minus those a later revert undid. */
function changesInForce(events: readonly RawEvent[]): Array<{ seq: number; data: CoordinatorProfileData }> {
  const stack: Array<{ seq: number; data: CoordinatorProfileData }> = [];
  for (const event of events) {
    if (event.type !== COORDINATOR_PROFILE_EVENT) continue;
    const data = event.data as CoordinatorProfileData;
    if (data.reverts !== undefined) {
      const index = stack.findIndex((change) => change.seq === data.reverts);
      if (index >= 0) stack.splice(index, 1);
    } else {
      stack.push({ seq: event.seq, data });
    }
  }
  return stack;
}

function sameModel(a: { provider: string; model: string | null }, b: SwitchTarget): boolean {
  if (a.provider !== b.provider) return false;
  if (a.provider === 'antigravity') return antigravityModelId(a.model ?? '') === antigravityModelId(b.model);
  return a.model === b.model;
}

/**
 * Put a coordinator on `profile`, or with `revert` undo its latest change
 * still in force. Refuses unless front is between turns.
 */
export async function changeCoordinatorProfile(
  conversationId: string,
  request: { profile?: string; revert?: boolean },
  deps: ProfileChangeDeps,
): Promise<ProfileChangeResult> {
  const { sessionManager, conversationService, settings } = deps;
  const conversation = conversationService.getConversation(conversationId);
  if (!conversation) return refused('not-found', `Conversation ${conversationId} not found`);
  if (!conversation.coordinator) return refused('not-coordinator', 'Only a project coordinator has a profile.');

  if (!sessionManager.hasSession(conversationId)) sessionManager.recoverFromStorage(conversationId);
  const status = sessionManager.inspect(conversationId)?.status;
  if (status && status !== 'idle') return refused('not-idle', `The coordinator is ${status}. Change its profile between turns.`);

  const recorded = conversationService.getProfile(conversationId);
  const current = profileForRecorded(recorded, settings).name;

  let to: string | null;
  let modelTarget: SwitchTarget | null = null;
  let reverts: number | undefined;
  if (request.revert) {
    const last = changesInForce(getEvents(conversationId)).at(-1);
    if (!last) return refused('nothing-to-revert', `${conversationId} has no profile change to undo; it is on "${current}".`);
    to = last.data.from;
    reverts = last.seq;
    if (last.data.switched) modelTarget = last.data.switched.from;
  } else {
    const name = request.profile?.trim();
    if (!name) return refused('invalid', 'Name a profile, or ask for a revert.');
    const found = findProfile(name, settings);
    if (!found) return refused('unknown-profile', `There is no coordinator profile "${name}".`);
    if (found.name === current) {
      return { status: 'unchanged', conversationId, profile: current };
    }
    to = found.name;
    const front = found.profile.front;
    const segment = conversationService.getLatestSegment(conversationId);
    if (front && segment && !sameModel(segment, { provider: front.provider, model: front.model })) {
      modelTarget = { provider: front.provider, model: front.model };
    }
  }

  // Recorded before any switch, so the switch's handover is built from the new profile.
  conversationService.setProfile(conversationId, to);
  let switched: CoordinatorProfileData['switched'];
  if (modelTarget) {
    const segment = conversationService.getLatestSegment(conversationId);
    const before: SwitchTarget = { provider: segment!.provider, model: segment!.model ?? '' };
    const result = await deps.switchTo(modelTarget);
    if (result.status !== 'switched' && result.status !== 'unchanged') {
      conversationService.setProfile(conversationId, recorded);
      const why = result.status === 'refused' ? result.reason : result.error;
      return refused('switch-failed', `Front's model could not move to ${modelTarget.provider} ${modelTarget.model}, so the profile stays "${current}": ${why}`);
    }
    if (result.status === 'switched') switched = { from: before, to: modelTarget };
  }

  appendCustomHarnessEvent(sessionManager, conversationId, COORDINATOR_PROFILE_EVENT, {
    from: recorded,
    to,
    ...(switched ? { switched } : {}),
    ...(reverts !== undefined ? { reverts } : {}),
  } satisfies CoordinatorProfileData);

  return {
    status: 'changed',
    conversationId,
    from: current,
    to: profileForRecorded(to, settings).name,
    ...(switched ? { switched } : {}),
    ...(reverts !== undefined ? { reverted: reverts } : {}),
  };
}

/**
 * The profile change front has not yet been told about: the newest
 * `coordinator:profile` event after its last real input, unless a model
 * switch delivered it (the switch's handover already carried the preamble).
 */
export function profileChangeSinceLastInput(newestFirst: Iterable<RawEvent>): CoordinatorProfileData | null {
  for (const event of newestFirst) {
    if (event.type === 'input:sent') {
      if ((event.data as { source?: string }).source === 'command') continue;
      return null;
    }
    if (event.type === COORDINATOR_PROFILE_EVENT) {
      const data = event.data as CoordinatorProfileData;
      return data.switched ? null : data;
    }
  }
  return null;
}
