/**
 * Workers a coordinator has dispatched, and its History with them, for the
 * right panel. Both come from `GET /api/conv/:id/workers`, which folds the
 * coordinator's full event log (the client's event window is paginated and
 * would miss a worker started before the window), as does the coordinator's
 * written project state. Refetched whenever a new worker:* or project:*
 * event reaches the client, whenever a session not heard from before sends a
 * message here, and whenever the coordinator's status
 * changes: "Question pending" vs "Waiting for coordinator" depends on both, and a
 * worker the coordinator archived during its turn shows as such once the
 * turn ends.
 *
 * Every one of those triggers is a frame arriving on a live stream, and a
 * phone drops the stream whenever it sleeps. The frames are pushes, not a
 * replayable log: a worker that stops during the gap rings a bell nobody is
 * listening to, and the card goes on saying Working with no second chance to
 * correct it. So the panel also refetches whenever the stream connects and
 * whenever the page becomes visible again — the endpoint is the authority,
 * and asking it once on waking is what makes the card true again.
 */

import { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { useActivityStream, useActivityStreamSubscription } from '../contexts/ActivityStreamContext';
import type { WorkersResponse } from '@/types/worker-events';

const EMPTY: WorkersResponse = { workers: [], history: [], project: null, senders: {} };

/**
 * The last answer seen for each conversation in this page. The view remounts
 * on every session switch, so without this the panel starts empty and waits
 * for the endpoint; with it, a project seen before shows as it was straight
 * away and the fetch that follows brings it up to date.
 */
const lastSeen = new Map<string, WorkersResponse>();

export function useWorkers(
  conversationId: string | null,
  lastWorkerEventSeq: number | null,
  coordinatorStatus: string,
  // The ids of every session seen sending a message into this conversation.
  // An agent message can arrive without any worker or status event, so this is
  // what makes a newly-heard-from peer resolve when it actually speaks.
  seenSenders = '',
  // Seq of the newest event in the coordinator's window. The three triggers
  // above are all derived from events, so an answer read at or after this seq
  // already reflects whatever moved them.
  lastEventSeq: number | null = null,
): WorkersResponse {
  const [response, setResponse] = useState<WorkersResponse>(() => (conversationId ? lastSeen.get(conversationId) : undefined) ?? EMPTY);
  // A worker's activity line changes inside the worker's own session, so no
  // coordinator event and no status change marks it. The server pushes a
  // worker-activity frame naming this coordinator; the endpoint stays the
  // authority for what the card shows.
  const [activitySeen, setActivitySeen] = useState(0);
  useActivityStreamSubscription({ type: 'activity' }, (event) => {
    const payload = event as { type?: string; sessionId?: string | null };
    if (payload.type !== 'worker-activity') return;
    if (payload.sessionId !== conversationId) return;
    setActivitySeen((value) => value + 1);
  });

  // A reconnect means frames were missed; a wake means they may have been
  // (the stream can come back from a phone's sleep without erroring, so a
  // healthy-looking connection is not evidence that nothing was dropped).
  const { connectionState } = useActivityStream();
  const streamConnectedAt = connectionState.lastConnectedAt?.getTime() ?? 0;
  const [wokeUp, setWokeUp] = useState(0);
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') setWokeUp((value) => value + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // One request at a time. A trigger that lands while one is in flight marks
  // it stale and gets a single refetch when it returns, rather than a second
  // request racing it: the old way discarded the first answer whenever a
  // trigger fired before it arrived (a session switch fires several), and
  // each extra request made the server fold the log again. The panel waited
  // for the last of them — 1.2s on the canary coordinator (2026-09-23).
  //
  // Triggers derived from the coordinator's events are also checked against
  // the seq the last answer was read at. Opening a session moves all three as
  // its window hydrates, just after the opening request has read past them;
  // asking again for each made three serial requests per switch (2026-09-29).
  // A switch, a worker's activity frame, a reconnect and a wake always ask.
  const current = useRef(conversationId);
  current.current = conversationId;
  const inFlight = useRef<string | null>(null);
  const stale = useRef<{ always: boolean; seq: number } | null>(null);
  const answeredAt = useRef<{ conversationId: string; seq: number } | null>(null);
  const alwaysKey = `${conversationId}|${activitySeen}|${streamConnectedAt}|${wokeUp}`;
  const lastAlwaysKey = useRef<string | null>(null);
  // Read, not a trigger: every streamed event moves it.
  const newestSeq = useRef(lastEventSeq);
  newestSeq.current = lastEventSeq;

  useEffect(() => {
    if (!conversationId) {
      setResponse(EMPTY);
      return;
    }
    const always = alwaysKey !== lastAlwaysKey.current;
    lastAlwaysKey.current = alwaysKey;
    const needSeq = newestSeq.current ?? Number.POSITIVE_INFINITY;
    const covered = (): boolean =>
      answeredAt.current?.conversationId === conversationId && answeredAt.current.seq >= needSeq;
    const load = (): void => {
      if (inFlight.current === conversationId) {
        stale.current = {
          always: always || (stale.current?.always ?? false),
          seq: Math.max(needSeq, stale.current?.seq ?? 0),
        };
        return;
      }
      inFlight.current = conversationId;
      stale.current = null;
      api.getWorkers(conversationId)
        .then((next) => {
          const seen = { workers: next.workers, history: next.history ?? [], project: next.project ?? null, senders: next.senders ?? {} };
          lastSeen.set(conversationId, seen);
          answeredAt.current = typeof next.asOfSeq === 'number' ? { conversationId, seq: next.asOfSeq } : null;
          if (current.current === conversationId) setResponse(seen);
        })
        .catch(() => {
          // The panel simply keeps what it had; the next event or status change retries.
        })
        .finally(() => {
          if (inFlight.current !== conversationId) return;
          inFlight.current = null;
          const pending = stale.current;
          stale.current = null;
          if (!pending || current.current !== conversationId) return;
          const answered = answeredAt.current?.conversationId === conversationId ? answeredAt.current.seq : -1;
          if (pending.always || pending.seq > answered) load();
        });
    };
    if (!always && covered()) return;
    load();
  }, [conversationId, lastWorkerEventSeq, coordinatorStatus, activitySeen, seenSenders, streamConnectedAt, wokeUp, alwaysKey]);

  return response;
}

/** How often an open panel says so; matches `WATCH_HEARTBEAT_MS` in services/sessions/worker-activity.ts. */
const WATCH_HEARTBEAT_MS = 60_000;

/**
 * Tells the server this coordinator's panel is open, so its workers' activity
 * lines are written. Only while `active` and the page is visible: a hidden tab
 * or a sleeping phone stops the heartbeat, and the server stops writing lines
 * a couple of minutes later.
 */
export function useWatchWorkers(coordinatorId: string | null, active: boolean): void {
  useEffect(() => {
    if (!coordinatorId || !active) return;
    const beat = (): void => {
      if (document.visibilityState !== 'visible') return;
      api.watchWorkers(coordinatorId).catch(() => {
        // The next beat retries; a missed one only lets a line go stale.
      });
    };
    beat();
    const timer = setInterval(beat, WATCH_HEARTBEAT_MS);
    document.addEventListener('visibilitychange', beat);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', beat);
    };
  }, [coordinatorId, active]);
}
