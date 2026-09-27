/**
 * Carrying a session on after a restart cut it off.
 *
 * Two restarts cut a session off. A server restart ends every turn in flight:
 * the new server cannot hear any process from the old one's lifetime, and the
 * boot sweep (startup-recovery-sweep.ts) closes those sessions. A daemon
 * restart ends every Claude process with it while the server stays up, and
 * the harness closes each live handle with a `run:end` of reason
 * `process_lost`. Either way a session that was mid-turn, or waiting on
 * background tasks, would sit idle until someone remembered to wake it.
 *
 * Both paths queue the same note in the session's inbox, and the inbox drain
 * delivers it as the session's next turn. A session somebody stopped is not
 * woken, even with background tasks still running, since that would undo the
 * Stop; an idle one with nothing running is not either.
 */

import { deriveStatus, type LostTask, type RunEndData, type SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { createLogger } from '../infrastructure/logger.js';
import { drainInbox, enqueueInboxItem } from './session-inbox.js';
import { ConfigService } from '../infrastructure/config-service.js';
import { compactingFromNewestFirst } from '../../harness/derive-session-status.js';
import { getHarnessSessionManager } from '../../harness/setup.js';

const logger = createLogger('RestartCarryOn');

/** Who the carry-on note is from, in the voice of the server's other notes. */
export const RESTART_NOTE_SENDER = 'the server';

export type RestartKind = 'server' | 'daemon';

/** What a session a restart cut off is told when it is woken. Exported for tests. */
export function restartResumeNote(
  cutOffAt: Date,
  inTurn: boolean,
  lostTasks: readonly LostTask[] = [],
  kind: RestartKind = 'server',
): string {
  const at = cutOffAt.toTimeString().slice(0, 5);
  const who = kind === 'server'
    ? 'The Lattice server restarted'
    : 'The Lattice background service that runs Claude processes restarted';
  const what = inTurn
    ? 'while your last turn was still running, and that turn was cut off'
    : 'while you were waiting on background tasks';
  const tasks = lostTasks.length === 0
    ? ''
    : ' These background tasks were running in the process the restart cut off, and their results will not ' +
      `reach you: ${lostTasks.map((t) => (t.description ? `"${t.description}" (${t.taskId})` : t.taskId)).join(', ')}.`;
  return (
    `${who} ${what} (last activity at ${at}). You were not stopped by anyone; this ` +
    `message is what wakes you.${tasks} ` +
    'The step you were in the middle of may or may not have completed: a file half-written, a command ' +
    'still running when it was killed, a commit or a push that did or did not land. Before repeating ' +
    'anything, check what your last step actually did, then carry on with the work you were doing. ' +
    'If the work was in fact finished, say so briefly rather than starting it again.'
  );
}

/**
 * Whether a session whose log ended with these events when it was cut off
 * should be woken. A Stop during its latest turn (a stop:requested after the
 * input that started the turn) keeps it asleep, whether or not the turn had
 * finished stopping.
 */
export function shouldCarryOn(events: readonly SessionEvent[], lostTasks: readonly LostTask[]): CarryOn {
  const status = deriveStatus(events as SessionEvent[]);
  const inTurn = status === 'starting' || status === 'streaming';
  let stopped = false;
  for (let i = events.length - 1; i >= 0 && events[i].type !== 'input:sent' && events[i].type !== 'run:start'; i--) {
    if (events[i].type === 'stop:requested') stopped = true;
  }
  const wake = status !== 'stopping' && !stopped && (inTurn || lostTasks.length > 0);
  const compacting = wake && compactingFromNewestFirst([...events].reverse());
  // A turn that was nothing but the compaction has no work to carry on; one
  // the provider compacted in the middle of does, once the compaction is
  // redone. Messages steered in while it compacted are still in the inbox.
  return { wake: wake && !(compacting && compactionWasTheTurn(events)), inTurn, compacting };
}

/** Whether the input that opened the newest compaction was `/compact` itself. */
function compactionWasTheTurn(events: readonly SessionEvent[]): boolean {
  let i = events.length - 1;
  while (i >= 0 && events[i].type !== 'context:compaction') i--;
  for (i -= 1; i >= 0; i--) {
    if (events[i].type !== 'input:sent') continue;
    return (events[i].data as { text?: string } | undefined)?.text?.trim() === '/compact';
  }
  return false;
}

export interface CarryOn {
  /** Queue the carry-on note. */
  wake: boolean;
  inTurn: boolean;
  /** The restart cut a compaction off; it is run again before anything else is sent. */
  compacting: boolean;
}

/** Sessions whose compaction a restart cut off, waiting to compact again. */
const compactionsOwed = new Set<string>();

export function noteCompactionCutOff(sessionId: string): void {
  compactionsOwed.add(sessionId);
  logger.info('A restart cut off this session\'s compaction; it will be run again', { sessionId });
}

/**
 * Run again every compaction a restart cut off. Awaited before the inbox
 * drains: the compaction opens a turn, the drain finds the session busy, and
 * the compaction's own turn end delivers the carry-on note and anything else
 * waiting — on the compacted context, as the interrupted compaction would
 * have. A compaction that cannot start is logged and the drain goes ahead.
 */
export async function rerunCutOffCompactions(): Promise<void> {
  const owed = [...compactionsOwed];
  compactionsOwed.clear();
  if (owed.length === 0) return;
  const { host, port, authToken } = ConfigService.getInstance().getConfig().server;
  const dialHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const headers: Record<string, string> = authToken ? { authorization: `Bearer ${authToken}` } : {};
  await Promise.all(owed.map(async (sessionId) => {
    try {
      const res = await fetch(`http://${dialHost}:${port}/api/harness/${sessionId}/compact`, { method: 'POST', headers });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      logger.info('Compaction a restart cut off is running again', { sessionId });
    } catch (err) {
      logger.error('Could not run again a compaction a restart cut off', err instanceof Error ? err : new Error(String(err)), { sessionId });
    }
  }));
}

/**
 * Queue the note. Keyed on the run:end that closed the session, so a second
 * pass over the same cut-off adds nothing.
 */
export function queueCarryOnNote(input: {
  sessionId: string;
  closedAtSeq: number;
  cutOffAt: Date;
  inTurn: boolean;
  lostTasks: readonly LostTask[];
  kind: RestartKind;
}): void {
  enqueueInboxItem({
    sessionId: input.sessionId,
    source: 'agent',
    sender: RESTART_NOTE_SENDER,
    text: restartResumeNote(input.cutOffAt, input.inTurn, input.lostTasks, input.kind),
    deliveryId: `restart-resume:${input.closedAtSeq}`,
  });
  logger.info('Queued carry-on note for a session a restart cut off', {
    sessionId: input.sessionId,
    kind: input.kind,
    closedAtSeq: input.closedAtSeq,
    inTurn: input.inTurn,
    lostTasks: input.lostTasks.length,
  });
}

/** Sessions the daemon took down with it, waiting for it to come back. */
const lostToDaemon = new Map<string, { closedAtSeq: number; cutOffAt: Date; inTurn: boolean; lostTasks: LostTask[]; wake: boolean }>();

/**
 * Called for every live `run:end`. One of reason `process_lost` means the
 * daemon connection dropped under the process. The note is held until the
 * daemon is back: sent now, it would fail to spawn and show as undeliverable.
 */
export function noteRunEnd(event: SessionEvent): void {
  const data = event.data as RunEndData | undefined;
  if (data?.reason !== 'process_lost') return;
  // The boot sweep writes its own process_lost and queues its own note.
  if ((event.meta as { source?: string } | undefined)?.source === 'recovery') return;
  const events = getHarnessSessionManager()?.getLog(event.sessionId)?.all() ?? [];
  const before = events.filter((e) => e.seq < event.seq);
  if (before.length === 0) return;
  const lostTasks = data.lostTasks ?? [];
  const { wake, inTurn, compacting } = shouldCarryOn(before, lostTasks);
  if (!wake && !compacting) return;
  if (compacting) noteCompactionCutOff(event.sessionId);
  lostToDaemon.set(event.sessionId, {
    closedAtSeq: event.seq,
    cutOffAt: new Date(before[before.length - 1].timestamp),
    inTurn,
    lostTasks: [...lostTasks],
    wake,
  });
  logger.info('Session lost its process with the daemon; it will be carried on when the daemon is back', {
    sessionId: event.sessionId,
    inTurn,
    compacting,
    lostTasks: lostTasks.length,
  });
}

/** The daemon is reachable again: queue and deliver every held note. */
export async function carryOnAfterDaemonReconnect(): Promise<void> {
  const held = [...lostToDaemon.entries()];
  lostToDaemon.clear();
  if (held.length === 0) return;
  logger.info('Daemon is back; carrying on the sessions it took down', { sessions: held.map(([id]) => id) });
  for (const [sessionId, { wake, ...entry }] of held) {
    if (!wake) continue;
    try {
      queueCarryOnNote({ sessionId, ...entry, kind: 'daemon' });
    } catch (err) {
      logger.error('Could not queue carry-on note after the daemon restart', err, { sessionId });
    }
  }
  await rerunCutOffCompactions();
  await Promise.all(held.map(([sessionId]) => drainInbox(sessionId)));
}
