/**
 * The coordinator panel (2026-10-09, thread 35160): the user's calls, what
 * is running and the project's pull requests and releases, drawn by
 * `NarrowPanel`. This works out the rows from the project state
 * (`deriveStateOfPlay`, `src/types/state-of-play.ts`), the workers, and the
 * coordinator's log (its latest question card and the replies held in the
 * panel).
 *
 * - Your calls (2026-10-09, thread 35804): the open decision points that are
 *   the user's, as a rolling log that fades with age (`types/your-calls.ts`).
 *   A row opens in place into the chat's decision card and is answered there
 *   (`YourCalls.tsx`); amber appears nowhere else in the panel. The chat's
 *   open question card is a row too, in place of the thread it is about.
 * - Workers: every live worker as its own row, named by its task, under
 *   Running unless a job it reported stands for it.
 *
 * Parking or dismissing a row says so in place, with Undo, for a few seconds.
 * Dismissing a thread parks it as the user's call and stops its workers
 * (`thread-dismissal.ts`); parking keeps it for later and its workers carry on.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { WorkerRow } from './WorkersSection';
import { NarrowPanel } from './NarrowPanel';
import type { WaitTextContext } from './WaitText';
import { CallRow, GoneRow, holdReply, threadAction, undoReply, type CallActions } from './YourCalls';
import { deriveStateOfPlay } from '@/types/state-of-play';
import { deriveCalls, type Call } from '@/types/your-calls';
import type { ProjectState } from '@/types/project-state';
import type { ShownDecision } from '@/types/decisions';
import type { HeldReply } from '@/types/held-replies';
import type { WorkerCardState } from '@/types/worker-events';

/** How long a parked or dismissed row offers Undo in place. */
const UNDO_MS = 15_000;

interface StateOfPlaySectionProps {
  project: ProjectState | null;
  workers: WorkerCardState[];
  coordinatorId?: string;
  coordinatorRunning: boolean;
  onOpenWorker?: (conversationId: string) => void;
  waitContext?: WaitTextContext;
  pointedWorker?: string | null;
  /** The coordinator's latest question card, once shown. */
  latestDecision?: ShownDecision | null;
  /** Replies held in the panel before they go, from the coordinator's log. */
  heldReplies?: ReadonlyMap<string, HeldReply>;
  /** When the user last replied about each thread and card (`repliedAt`). */
  repliedAt?: ReadonlyMap<string, number>;
}

/** A row parked or dismissed here, saying so until its Undo lapses. */
type Gone = { key: string; seq: number; name: string; word: 'parked' | 'dismissed'; index: number; error?: string };

const NO_REPLIES: ReadonlyMap<string, HeldReply> = new Map();
const NO_TIMES: ReadonlyMap<string, number> = new Map();

/** Ticks twice a second while a row is sending or leaving, else once a minute for the ages. */
function useNow(fast: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), fast ? 500 : 60_000);
    return () => clearInterval(timer);
  }, [fast]);
  return now;
}

export function StateOfPlaySection({
  project, workers, coordinatorId, coordinatorRunning, onOpenWorker, waitContext, pointedWorker, latestDecision = null, heldReplies = NO_REPLIES, repliedAt = NO_TIMES,
}: StateOfPlaySectionProps): JSX.Element | null {
  const [gone, setGone] = useState<Gone[]>([]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => () => { for (const timer of timers.current.values()) clearTimeout(timer); }, []);

  const play = deriveStateOfPlay(project ?? EMPTY_PROJECT, workers);
  const busy = [...heldReplies.values()].some((reply) => reply.state === 'held' || (reply.at !== null && Date.now() - reply.at < 5_000));
  const now = useNow(busy);
  const calls = deriveCalls({ needsYou: play.needsYou, open: project?.open, latestDecision, heldReplies, repliedAt, now });

  const forget = (key: string) => {
    clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    setGone((current) => current.filter((entry) => entry.key !== key));
  };

  const putAway = async (call: Call, word: Gone['word']) => {
    if (!coordinatorId || !call.thread) return;
    const seq = call.thread.seq;
    setOpenKey(null);
    setGone((current) => [...current.filter((entry) => entry.key !== call.key), { key: call.key, seq, name: call.name, word, index: calls.indexOf(call) }]);
    try {
      await threadAction(coordinatorId, seq, word === 'parked' ? 'park' : 'dismiss');
      timers.current.set(call.key, setTimeout(() => forget(call.key), UNDO_MS));
    } catch (err) {
      setGone((current) => current.map((entry) => entry.key === call.key ? { ...entry, error: err instanceof Error ? err.message : String(err) } : entry));
    }
  };

  const restore = async (entry: Gone) => {
    if (!coordinatorId) return;
    forget(entry.key);
    try {
      await threadAction(coordinatorId, entry.seq, 'restore');
    } catch (err) {
      setGone((current) => [...current, { ...entry, error: err instanceof Error ? err.message : String(err) }]);
    }
  };

  const actions: CallActions = {
    onAnswer: async (call, text) => {
      if (!coordinatorId) return;
      const target = call.decision ? { kind: 'answer' as const, decision: call.decision.id } : { kind: 'thread' as const, thread: call.thread!.seq };
      await holdReply(coordinatorId, target, text);
      setOpenKey(null);
    },
    onUndo: async (_call, heldId) => {
      if (coordinatorId) await undoReply(coordinatorId, heldId);
    },
    onPark: (call) => void putAway(call, 'parked'),
    onDismiss: (call) => {
      if (call.thread) {
        void putAway(call, 'dismissed');
        return;
      }
      // A card about no thread: its dismissal is held like an answer, with Undo.
      if (coordinatorId && call.decision) {
        setOpenKey(null);
        holdReply(coordinatorId, { kind: 'dismiss', decision: call.decision.id }, '').catch((err: unknown) => console.error('Dismissing the question failed:', err));
      }
    },
  };

  const toggle = useCallback((key: string) => setOpenKey((current) => (current === key ? null : key)), []);

  // A parked or dismissed row keeps its place, saying so, until its Undo lapses.
  const rows: React.ReactNode[] = calls
    .filter((call) => !gone.some((entry) => entry.key === call.key))
    .map((call) => (
      <CallRow key={call.key} call={call} now={now} open={openKey === call.key} onToggle={() => toggle(call.key)} actions={actions} />
    ));
  for (const entry of [...gone].sort((a, b) => a.index - b.index)) {
    rows.splice(Math.min(Math.max(entry.index, 0), rows.length), 0, (
      <GoneRow key={`gone-${entry.key}`} name={entry.name} word={entry.word} error={entry.error} onUndo={() => void restore(entry)} />
    ));
  }

  return (
    <NarrowPanel
      coordinatorId={coordinatorId}
      attention={rows}
      workers={play.workers}
      coordinatorRunning={coordinatorRunning}
      onOpenWorker={onOpenWorker}
      renderWorker={(worker, jobs) => (
        <WorkerRow
          key={worker.worker}
          worker={worker}
          jobs={jobs}
          coordinatorRunning={coordinatorRunning}
          onOpen={onOpenWorker}
          waitContext={waitContext}
          pointed={pointedWorker === worker.worker}
          pointing={Boolean(pointedWorker)}
        />
      )}
    />
  );
}

const EMPTY_PROJECT: ProjectState = {
  outcome: null, decisions: [], retired: [], priority: null, rank: [], open: [], closed: [],
  attention: [], historical: [], accountingFrom: null, now: null, answeredBefore: null, nudges: 0, revision: 0,
};
