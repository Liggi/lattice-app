/**
 * Whether a coordinator switch (coordinator-switch.ts) was left unfinished,
 * and what anything that would start a turn is told when it was. Kept apart
 * from the switch itself so the paths it has to block — send, resume, start,
 * compaction — can ask without importing the switch.
 */

import { getEvents } from '../../session-history/repository.js';
import type { ConversationService, Provider } from './conversation-service.js';

export const COORDINATOR_SWITCH_EVENT = 'coordinator:switch';

export interface SwitchTarget {
  provider: Provider;
  model: string;
}

export interface CoordinatorSwitchData {
  phase: 'requested' | 'completed' | 'failed';
  from: { provider: Provider; model: string | null; segmentId: string };
  to: { provider: Provider; model: string; segmentId: string };
  error?: string;
  /** Failed only: whether the previous provider was started again. */
  restored?: boolean;
}

export function label(provider: Provider, model: string | null): string {
  return model ? `${provider} ${model}` : provider;
}

function lastSwitchEvent(conversationId: string): CoordinatorSwitchData | null {
  const events = getEvents(conversationId, { types: [COORDINATOR_SWITCH_EVENT] })
    .filter((event) => event.type === COORDINATOR_SWITCH_EVENT);
  const last = events[events.length - 1];
  return last ? last.data as CoordinatorSwitchData : null;
}

export const PENDING_SWITCH_PREFIX = 'pending-switch-';

/**
 * A switch that did not reach a settled state: the server stopped between
 * adding the segment and confirming the reply (whether or not the new model
 * had started, so whether or not the segment still holds a pending id), or a
 * failed switch could not start the previous provider again. Either way the
 * segment and the process the harness would respawn may disagree, so nothing
 * is sent until `switch` is called again, which undoes it.
 */
export interface UnfinishedSwitch {
  from: SwitchTarget | { provider: Provider; model: string | null };
  fromSegmentId: string;
  /** The segment the switch added, if it is still there. */
  toSegmentId: string | null;
  to: SwitchTarget | null;
  why: string;
}

export function unfinishedSwitch(conversationId: string, conversationService: ConversationService): UnfinishedSwitch | null {
  const conversation = conversationService.getConversation(conversationId);
  if (!conversation?.coordinator) return null;
  const latest = conversationService.getLatestSegment(conversationId);
  const last = lastSwitchEvent(conversationId);
  if (last && (last.phase === 'requested' || (last.phase === 'failed' && last.restored === false))) {
    return {
      from: { provider: last.from.provider, model: last.from.model },
      fromSegmentId: last.from.segmentId,
      toSegmentId: latest?.segmentId === last.to.segmentId ? last.to.segmentId : null,
      to: { provider: last.to.provider, model: last.to.model },
      why: last.phase === 'requested'
        ? 'it was interrupted before the new model answered its handover'
        : `it failed (${last.error ?? 'no reason recorded'}) and ${label(last.from.provider, last.from.model)} did not start again`,
    };
  }
  // Stopped between adding the segment and recording the request.
  if (latest?.providerSessionId.startsWith(PENDING_SWITCH_PREFIX) && last?.to.segmentId !== latest.segmentId) {
    const previous = [...conversation.segments]
      .filter((segment) => segment.segmentId !== latest.segmentId)
      .sort((x, y) => x.sequenceNumber - y.sequenceNumber)
      .pop();
    if (!previous) return null;
    return {
      from: { provider: previous.provider, model: previous.model },
      fromSegmentId: previous.segmentId,
      toSegmentId: latest.segmentId,
      to: latest.model ? { provider: latest.provider, model: latest.model } : null,
      why: 'it was interrupted before it was recorded',
    };
  }
  return null;
}

/** What a send to a coordinator with an unfinished switch is told, or null when there is none. */
export function unfinishedSwitchRefusal(conversationId: string, conversationService: ConversationService, cli: string): string | null {
  const unfinished = unfinishedSwitch(conversationId, conversationService);
  if (!unfinished) return null;
  const target = unfinished.to ? ` --provider ${unfinished.to.provider} --model ${unfinished.to.model}` : ' --provider claude --model <model>';
  return `This coordinator's switch from ${label(unfinished.from.provider, unfinished.from.model)} did not finish: ${unfinished.why}. `
    + 'Nothing is sent to it until that is resolved, because the recorded provider and the process a send would start may differ. '
    + `Run \`${cli} session switch ${conversationId}${target}\`: it undoes the unfinished switch and starts `
    + `${label(unfinished.from.provider, unfinished.from.model)} again; run it once more to switch. Messages already in the inbox wait.`;
}

