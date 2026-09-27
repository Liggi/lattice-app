import type { NeedsYouItem, UnifiedConversationSummary } from '../types';

/**
 * When a conversation was last used. `updatedAt` alone only moves on the legacy
 * /resume route and on segment changes, so it mostly stays at creation time.
 * The card's age label and the Idle/Sleeping split read this.
 */
export function lastUsedAt(session: UnifiedConversationSummary): number {
  return new Date(session.lastActivityAt ?? session.updatedAt).getTime();
}

/**
 * Quiet for longer than this, a session is Sleeping rather than Idle. The
 * server's auto-archive (auto-archive-service.ts) archives it a week later.
 */
export const SLEEP_AFTER_MS = 30 * 60 * 1000;

/**
 * A project's ask lights Needs you for this long after it was made; after
 * that it no longer shows (decided 2026-09-26: an hour on, it shouldn't be
 * highlighted anymore — and no quiet dot in its place).
 */
export const NEEDS_YOU_FRESH_MS = 60 * 60 * 1000;

/**
 * Needs you names one ask. A second or third is shown only when it is clearly
 * important too: Jev scored it at least this high (the bar for showing at all
 * is 0.55; today's asks run 0.63–0.82).
 */
export const NEEDS_YOU_ALSO_SCORE = 0.75;
const MAX_ASKS = 3;

/**
 * How strongly Needs you shows for a project ask, from 0 to 1: the icon is
 * brighter and pulses harder for an ask that is fresh and scored high, and
 * dims and slows as it ages or scores lower. Freshness runs from 1 when asked
 * to 0 at the hour; the score counts for half, scaled from the 0.55 bar
 * (half strength) to 0.85 and above (full).
 */
export function needsYouStrength(item: NeedsYouItem, now: number = Date.now()): number {
  const freshness = Math.max(0, 1 - (now - item.since) / NEEDS_YOU_FRESH_MS);
  const weight = Math.min(1, Math.max(0, (item.score - 0.55) / 0.3));
  return Math.round(freshness * (0.5 + 0.5 * weight) * 10) / 10;
}

/** The project's fresh asks worth naming: the top one, plus at most two clearly important others. */
export function freshAsks(
  conversation: UnifiedConversationSummary,
  now: number = Date.now(),
): NeedsYouItem[] {
  const fresh = (conversation.projectNeedsYou ?? [])
    .filter(item => now - item.since < NEEDS_YOU_FRESH_MS)
    .sort((a, b) => b.score - a.score);
  return fresh.filter((item, i) => i === 0 || item.score >= NEEDS_YOU_ALSO_SCORE).slice(0, MAX_ASKS);
}

export type WorkingLevel = 1 | 2 | 3;

export type SessionActivity =
  | { kind: 'needs-you'; asks?: NeedsYouItem[]; /** 0–1; absent for a prompt or question, which is always full. */ strength?: number }
  | { kind: 'failed'; message: string }
  | { kind: 'compacting' }
  | { kind: 'working'; level: WorkingLevel; busyWorkers: number }
  | { kind: 'waiting' }
  | { kind: 'idle' }
  | { kind: 'sleeping' };

/** Every state the icon can draw. */
export type SessionActivityKind = SessionActivity['kind'];

/** A worker counts as busy while it runs or holds work that will report back. */
function workerBusy(c: UnifiedConversationSummary): boolean {
  return c.status === 'pending' || c.status === 'ongoing' || Boolean(c.pendingWork);
}

/**
 * The one place a sidebar row's state is decided, from what the server already
 * reports: an open permission prompt or question (including a running turn
 * held on its question card), a last run that ended in an
 * error, a project ask Jev judges needs the user made within the hour, compaction, whether the
 * session or any of its workers is running, work it armed that will report
 * back, and how long it has been quiet. Working has three levels by busy
 * workers — none or one, two or three, four or more.
 */
export function deriveSessionActivity(
  conversation: UnifiedConversationSummary,
  conversations: UnifiedConversationSummary[],
  needsYou: boolean,
  now: number = Date.now(),
): SessionActivity {
  if (needsYou || conversation.awaitingAnswer) return { kind: 'needs-you' };
  if (conversation.failure) return { kind: 'failed', message: conversation.failure.message };
  const asks = freshAsks(conversation, now);
  if (asks.length > 0) return { kind: 'needs-you', asks, strength: Math.max(...asks.map(item => needsYouStrength(item, now))) };
  if (conversation.compacting) return { kind: 'compacting' };

  const busyWorkers = conversations.filter(c =>
    c.pickedUpFrom === conversation.conversationId && !c.archived && workerBusy(c)).length;
  const running = conversation.status === 'pending' || conversation.status === 'ongoing';

  if (running || busyWorkers > 0) {
    const level: WorkingLevel = busyWorkers >= 4 ? 3 : busyWorkers >= 2 ? 2 : 1;
    return { kind: 'working', level, busyWorkers };
  }
  if (conversation.pendingWork) return { kind: 'waiting' };
  return now - lastUsedAt(conversation) > SLEEP_AFTER_MS ? { kind: 'sleeping' } : { kind: 'idle' };
}

const PENDING_WORK_WORDS: Record<NonNullable<UnifiedConversationSummary['pendingWork']>, string> = {
  background_task: 'background command',
  subagent: 'subagent',
  workflow: 'workflow',
  scheduled_wakeup: 'scheduled wake-up',
};

export function quietFor(ms: number): string {
  const mins = Math.max(1, Math.floor(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** The icon's tooltip: the state in words, with the one detail that matters. */
export function describeSessionActivity(
  activity: SessionActivity,
  conversation: UnifiedConversationSummary,
  now: number = Date.now(),
): string {
  switch (activity.kind) {
    case 'needs-you': {
      if (!activity.asks?.length) return 'Needs you · permission or question';
      const more = activity.asks.length - 1;
      return `Needs you · ${activity.asks[0].text}${more > 0 ? ` · ${more} more` : ''}`;
    }
    case 'failed': return `Failed · ${activity.message}`;
    case 'compacting': return 'Compacting';
    case 'working':
      return activity.busyWorkers === 0
        ? 'Working'
        : `Working · ${activity.busyWorkers} worker${activity.busyWorkers === 1 ? '' : 's'}`;
    case 'waiting':
      return conversation.pendingWork
        ? `Waiting · ${PENDING_WORK_WORDS[conversation.pendingWork]}`
        : 'Waiting';
    case 'idle': return `Idle · ${quietFor(now - lastUsedAt(conversation))}`;
    case 'sleeping': return `Sleeping · idle ${quietFor(now - lastUsedAt(conversation))}`;
  }
}
