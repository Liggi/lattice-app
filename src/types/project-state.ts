/**
 * Project state — what a coordinator has decided, as opposed to what it has
 * done. The worker roster, reports and questions are derived from worker
 * events the server writes; this is the half only the coordinator can
 * supply: the outcome it is working towards, the decisions taken, the
 * threads still open, and what the current turn is doing.
 *
 * Each note is a `project:noted` event in the coordinator's own log,
 * written when it runs `lattice session note`. The state is a fold over
 * those events, so it survives compaction and restarts the same way the
 * roster does, and the send route can put it back in front of the
 * coordinator after a compaction (see `context-compaction.ts`).
 *
 * An open thread is more than its text. It carries who owns it, what
 * advances it, and what it is waiting on, because prose cannot be queried:
 * threads that named their owners in English linked nothing to the worker
 * on them, and no check could answer "which ready work has nobody on it". The
 * thread's id is the seq of the `open` note that created it and never
 * changes, so an `update` keeps the thread's identity and its original text
 * as the intended outcome.
 *
 * A worker's report or question is pending coordinator attention from the
 * moment it is written until a thread transition accounts for that exact
 * event. Delivering it into a turn is not handling it, and neither is a
 * `--now` note: the old check only noticed a turn that wrote *no* note at
 * all, so an ignored report passed while an unrelated `--now` satisfied it.
 * What discharges an event is named in `foldProjectState` below.
 *
 * The state separates what is currently true from what once was. Decisions
 * are append-only events, but a decision a later one replaces — named by seq,
 * never guessed from prose — leaves the active set and is kept in `retired`
 * with what took it out. Closed threads and pre-accounting reports are held
 * the same way. That split is what makes one projection small enough to put
 * in front of every turn: front's own record folded to 58 decisions and 49
 * historical reports, 24KB, and the active half of it is a fraction of that.
 *
 * `priority` is the durable counterpart to `now`. `now` describes a turn and
 * is cleared when it ends; a priority is the work the project is on, and it
 * survives the turn, a compaction and a cold resume.
 *
 * Shared by the server (writer, `/project` endpoint, restore block,
 * orientation), the web client (Project block in the coordinator panel) and
 * the orientation reviewer (which reads `open`, `attention` and `revision`
 * and writes no notes of its own), so no dependencies.
 */


export const PROJECT_NOTED_EVENT = 'project:noted';
/** The server put a state nudge in front of an input; counted so the discipline can be measured. */
export const PROJECT_NUDGED_EVENT = 'project:nudged';
/**
 * Every event type `foldProjectState` reads. A coordinator's log is mostly
 * streamed content (35k of the canary coordinator's 38.6k events), so the
 * server reads only these rather than parsing the whole log for each fold.
 */
export const PROJECT_FOLD_EVENT_TYPES = [
  PROJECT_NOTED_EVENT, PROJECT_NUDGED_EVENT, 'turn:end',
  'worker:started', 'worker:asked', 'worker:answered', 'worker:reported', 'worker:moved',
] as const;

export const PROJECT_NOTE_KINDS = [
  'outcome', 'decision', 'open', 'update', 'close', 'now', 'accounting', 'reconcile', 'priority', 'retire',
] as const;


/** What a coordinator found when it looked at a report written before accounting existed. */
export const RECONCILE_DISPOSITIONS = ['handled', 'superseded', 'open'] as const;
export type ReconcileDisposition = (typeof RECONCILE_DISPOSITIONS)[number];
export type ProjectNoteKind = (typeof PROJECT_NOTE_KINDS)[number];

/** Who is to move a thread next. `external` is anyone outside this project (a review, another team). */
export type ThreadOwner =
  | { kind: 'coordinator' }
  | { kind: 'user' }
  | { kind: 'worker'; worker: string }
  | { kind: 'external'; who: string };

export const THREAD_WAIT_KINDS = ['worker', 'decision', 'dependency', 'resource'] as const;
export type ThreadWaitKind = (typeof THREAD_WAIT_KINDS)[number];

/**
 * Why a thread is not ready. A `worker` wait names the worker, so it can be
 * checked against the roster; the rest are the coordinator's own words and
 * are context, not proof that the thing waited on has resolved. A
 * `dependency` on another thread of the same project may name it.
 */
export interface ThreadWait {
  kind: ThreadWaitKind;
  text: string;
  worker?: string;
  thread?: number;
}

export interface ProjectNotedData {
  kind: ProjectNoteKind;
  text: string;
  /** Whose call a decision was; the coordinator's unless it says otherwise. */
  by: 'coordinator' | 'user';
  /** For `outcome`: the project's short name, as the coordinator wrote it with the outcome. */
  name?: string;
  /** For `update` and `close`: the seq of the `open` note, which is the thread's id. */
  ref?: number;
  /** For `open` and `update`. Absent means unchanged; `waitingOn: null` means ready. */
  owner?: ThreadOwner;
  nextAction?: string;
  waitingOn?: ThreadWait | null;
  /** Workers this thread is being carried by; added to whatever it already has. */
  workers?: string[];
  /** For `update`, `close` and `reconcile`: seqs of the worker events this note accounts for. */
  addresses?: number[];
  /** For `reconcile`: what the coordinator found when it looked at those events. */
  disposition?: ReconcileDisposition;
  /**
   * For `decision` and `retire`: the seqs of the decisions this note takes out
   * of the active set. Named, never inferred — a correction says which
   * instruction it replaces, so no later reader has to work out from prose
   * which of two contradictory decisions still binds.
   */
  supersedes?: number[];
  /** For `open` and `update`: where the evidence for this thread is, added to what it already has. */
  evidence?: string[];
  /** For `open`: the thread this one was moved from, in another project (`session move-thread`). */
  movedFrom?: { coordinator: string; thread: number };
  /** For `close`: the thread this one became in the project it was moved to. */
  movedTo?: { coordinator: string; thread: number };
}

export interface ProjectDecision {
  seq: number;
  at: number;
  text: string;
  by: 'coordinator' | 'user';
}

/** A decision a later note replaced or retired. Kept, with what took it out. */
export interface RetiredDecision extends ProjectDecision {
  /** Seq of the `decision` that replaced it or the `retire` that withdrew it. */
  retiredBy: number;
  retiredAt: number;
  /** What that note said — the replacement's text, or the reason for the retirement. */
  reason: string;
}

/**
 * The one piece of remaining work this project is on. Unlike `now`, which
 * describes a turn and is cleared at its end, a priority outlives the turn
 * that set it: it is what the project session should still be working
 * towards after a compaction or a cold resume. A later `priority` note
 * replaces it, and closing the thread it names clears it.
 */
export interface ProjectPriority {
  seq: number;
  at: number;
  text: string;
  /** The open thread it concerns, when it names one. */
  thread: number | null;
}


/** A report or question from a worker, as it stands against the thread it came in on. */
export interface ThreadEvent {
  seq: number;
  at: number;
  kind: 'question' | 'report';
  worker: string;
  addressed: boolean;
  /** A locator, not the substance: read the event at `seq` for the full text. */
  firstLine: string;
}

export interface ProjectOpenThread {
  seq: number;
  at: number;
  /** What this thread is for, as written when it opened; an update does not replace it. */
  text: string;
  /**
   * Where the work has actually got to, as the last update that said so left
   * it. The intended outcome is `text` and does not move; this does. Without
   * it, "built but not integrated" had to be guessed from the next action.
   */
  summary: string | null;
  /** Where to look for what established the summary: a branch, a commit, a report seq. */
  evidence: string[];
  /** null when the thread has never been reconciled — prose from before ownership was recorded. */
  owner: ThreadOwner | null;
  nextAction: string | null;

  /** null means ready: nothing is blocking it. */
  waitingOn: ThreadWait | null;
  workers: string[];
  events: ThreadEvent[];
  /** Timestamp of the last note that touched this thread. */
  updatedAt: number;
  /**
   * When the current owner and wait were set: the note that last changed
   * either. Notes that only move the summary or next action leave it, so it
   * is how long the thread has waited on whoever it waits on now.
   */
  waitingSince: number;
  /** Set on a closed thread. */
  closedAt?: number;
  resolution?: string;
}

/** A worker event no thread transition has accounted for yet. Oldest first. */
export interface PendingAttention {
  seq: number;
  at: number;
  kind: 'question' | 'report';
  worker: string;
  /** The thread the worker was on when it wrote this; null when it was on none. */
  thread: number | null;
  firstLine: string;
  /**
   * When this started waiting. Its own time, except for a pre-boundary event
   * a coordinator reconciled as still needing work, where it is the time of
   * that reconciliation — so age is counted from when it became someone's
   * problem, not from when it was written.
   */
  since: number;
  /** Set only on a historical event reconciled back into attention. */
  reconciledAt?: number;
}

export interface ProjectState {
  outcome: string | null;
  /**
   * The decisions that still bind, newest last. A decision a later one
   * replaced, or a `retire` note withdrew, is in `retired` instead — so
   * everything reading this state (the panel, a worker's restore block, the
   * fast responder) is reading current instructions rather than a pile that
   * contains both a rule and its correction.
   */
  decisions: ProjectDecision[];
  /** Decisions no longer in force, with what took each one out. History, not a backlog. */
  retired: RetiredDecision[];
  /** The remaining work this project is on now, or null when none has been named. */
  priority: ProjectPriority | null;
  open: ProjectOpenThread[];
  closed: ProjectOpenThread[];

  /** Worker reports and questions still owed a disposition. */
  attention: PendingAttention[];
  /**
   * Worker reports and questions from before this coordinator started
   * accounting for them. Their disposition is unknown, not neglected: they have
   * no thread because the closures that did dispose of them predate the flag
   * that would have recorded it. They are shown
   * so they can be worked through, and they never raise a nudge or count
   * against a turn.
   */
  historical: PendingAttention[];
  /**
   * Seq of the note that started strict accounting here; null when this
   * coordinator predates it. Written once, either automatically on a new
   * coordinator's first dispatch or by `--account-from-now`, never inferred.
   */
  accountingFrom: number | null;
  /** What the current turn is doing; null once the turn has ended. */
  now: string | null;
  /** How many times the server has had to ask for the state to be noted. */
  nudges: number;
  /**
   * Seq of the newest note or worker event folded in. A cursor for anything
   * watching this state (the orientation reviewer polls it). Events a
   * reviewer writes into the same log are not notes or worker events, so
   * they do not move it.
   */
  revision: number;
}

export interface ProjectEventLike {
  seq: number;
  type: string;
  timestamp: number;
  data: unknown;
}

export function emptyProjectState(): ProjectState {
  return {
    outcome: null, decisions: [], retired: [], priority: null, open: [], closed: [],
    attention: [], historical: [], accountingFrom: null, now: null, nudges: 0, revision: 0,
  };
}


function firstLineOf(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
}

function normalizeOwner(owner: unknown): ThreadOwner | null {
  if (!owner || typeof owner !== 'object') return null;
  const candidate = owner as { kind?: string; worker?: unknown; who?: unknown };
  switch (candidate.kind) {
    case 'coordinator': return { kind: 'coordinator' };
    case 'user': return { kind: 'user' };
    case 'worker': return typeof candidate.worker === 'string' && candidate.worker ? { kind: 'worker', worker: candidate.worker } : null;
    case 'external': return typeof candidate.who === 'string' && candidate.who ? { kind: 'external', who: candidate.who } : null;
    default: return null;
  }
}

function normalizeWait(wait: unknown): ThreadWait | null {
  if (!wait || typeof wait !== 'object') return null;
  const candidate = wait as Partial<ThreadWait>;
  if (!candidate.kind || !(THREAD_WAIT_KINDS as readonly string[]).includes(candidate.kind)) return null;
  if (typeof candidate.text !== 'string') return null;
  return {
    kind: candidate.kind,
    text: candidate.text,
    ...(typeof candidate.worker === 'string' && candidate.worker ? { worker: candidate.worker } : {}),
    ...(typeof candidate.thread === 'number' ? { thread: candidate.thread } : {}),
  };
}

/** Apply the structured half of an `open` or `update` note to a thread. */
function applyThreadFields(thread: ProjectOpenThread, data: Partial<ProjectNotedData>, at: number): void {
  const waitBefore = JSON.stringify([thread.owner, thread.waitingOn]);
  if (data.owner !== undefined) {
    const owner = normalizeOwner(data.owner);
    if (owner) thread.owner = owner;
  }
  if (typeof data.nextAction === 'string' && data.nextAction.trim()) thread.nextAction = data.nextAction.trim();
  if ('waitingOn' in data) thread.waitingOn = data.waitingOn === null ? null : normalizeWait(data.waitingOn) ?? thread.waitingOn;
  if (JSON.stringify([thread.owner, thread.waitingOn]) !== waitBefore) thread.waitingSince = at;
  if (Array.isArray(data.workers)) {
    for (const worker of data.workers) {
      if (typeof worker === 'string' && worker && !thread.workers.includes(worker)) thread.workers.push(worker);
    }
  }
  if (Array.isArray(data.evidence)) {
    for (const pointer of data.evidence) {
      if (typeof pointer === 'string' && pointer.trim() && !thread.evidence.includes(pointer.trim())) {
        thread.evidence.push(pointer.trim());
      }
    }
  }
}


/**
 * Fold a coordinator's events (oldest first) into its project state.
 *
 * A worker's report or question is pending until one of three things
 * accounts for that exact event:
 *
 *   - an `update` or `close` note whose `addresses` names its seq;
 *   - a `worker:answered` whose `answers` names its seq — an ordinary
 *     message to a worker does not, because a coordinator also sends
 *     resource updates and pauses, and treating those as answers would be
 *     the same loophole as a generic note;
 *   - closing the thread the worker was attached to when it wrote the
 *     event, which accounts for that thread's events up to the close and
 *     leaves a reused worker's events on other threads pending.
 *
 * Delivery into a turn, a `--now` note, a new `open` note and archiving the
 * worker all leave it pending.
 */
export function foldProjectState(events: readonly ProjectEventLike[]): ProjectState {
  const state = emptyProjectState();
  const threads = new Map<number, ProjectOpenThread>();
  const closedOrder: number[] = [];
  /** Which thread each worker is on right now; an event is attributed to that thread. */
  const workerThread = new Map<string, number>();
  const pending = new Map<number, PendingAttention>();
  /**
   * Worker events written before accounting was switched on here. They are
   * held apart from `pending` so nothing warns about them, and a coordinator
   * moves one out of here only by reconciling it explicitly.
   */
  const historical = new Map<number, PendingAttention>();
  /** Every thread event by seq, so a later note can mark it addressed in place. */
  const threadEvents = new Map<number, ThreadEvent>();
  /** Every decision by seq, active and retired alike; the two lists are views of it. */
  const decisions = new Map<number, ProjectDecision>();
  const retired = new Map<number, RetiredDecision>();
  let accountingFrom: number | null = null;

  /**
   * Take a decision out of the active set, naming the note that did it. Only
   * a decision this project actually made can be retired, and only once: a
   * second note aimed at the same seq changes nothing, so a retirement cannot
   * be rewritten by a later one that knows less.
   */
  const retire = (target: number, by: ProjectEventLike, reason: string): void => {
    const decision = decisions.get(target);
    if (!decision || retired.has(target)) return;
    retired.set(target, { ...decision, retiredBy: by.seq, retiredAt: by.timestamp, reason });
  };


  const discharge = (seq: number): void => {
    pending.delete(seq);
    historical.delete(seq);
    const event = threadEvents.get(seq);
    if (event) event.addressed = true;
  };

  for (const event of events) {
    if (event.type === PROJECT_NUDGED_EVENT) {
      state.nudges += 1;
      continue;
    }
    // `now` describes the turn that set it and nothing after.
    if (event.type === 'turn:end') {
      state.now = null;
      continue;
    }

    if (event.type === 'worker:started') {
      state.revision = event.seq;
      const data = event.data as { worker?: string; thread?: unknown } | null;
      if (data?.worker && typeof data.thread === 'number') {
        const thread = threads.get(data.thread);
        if (thread) {
          workerThread.set(data.worker, data.thread);
          if (!thread.workers.includes(data.worker)) thread.workers.push(data.worker);
        }
      }
      continue;
    }

    if (event.type === 'worker:asked' || event.type === 'worker:reported') {
      state.revision = event.seq;
      const data = event.data as { worker?: string; text?: unknown } | null;
      if (!data?.worker) continue;
      const kind = event.type === 'worker:asked' ? 'question' : 'report';
      const firstLine = firstLineOf(data.text);
      // A copy a move carried over with its thread names that thread; the
      // worker that wrote it may not have come along.
      const named = (event.data as { thread?: unknown }).thread;
      const threadSeq = typeof named === 'number' && threads.has(named) ? named : workerThread.get(data.worker) ?? null;
      const item: PendingAttention = {
        seq: event.seq, at: event.timestamp, kind, worker: data.worker, thread: threadSeq, firstLine, since: event.timestamp,
      };
      // Before the boundary nothing was recording dispositions, so an event
      // sitting here proves only that the flag did not exist yet.
      if (accountingFrom === null) historical.set(event.seq, item);
      else pending.set(event.seq, item);
      if (threadSeq !== null) {
        const thread = threads.get(threadSeq);
        if (thread) {
          const threadEvent: ThreadEvent = { seq: event.seq, at: event.timestamp, kind, worker: data.worker, addressed: false, firstLine };
          thread.events.push(threadEvent);
          threadEvents.set(event.seq, threadEvent);
        }
      }
      continue;
    }

    if (event.type === 'worker:moved') {
      state.revision = event.seq;
      // What it wrote here and nobody had accounted for went with it, copied
      // into the project it moved to, which owes the disposition now.
      const worker = (event.data as { worker?: string } | null)?.worker;
      if (!worker) continue;
      for (const item of [...pending.values()]) if (item.worker === worker) discharge(item.seq);
      workerThread.delete(worker);
      continue;
    }

    if (event.type === 'worker:answered') {
      state.revision = event.seq;
      const answers = (event.data as { answers?: unknown } | null)?.answers;
      if (typeof answers === 'number') discharge(answers);
      continue;
    }

    if (event.type !== PROJECT_NOTED_EVENT) continue;
    const data = event.data as Partial<ProjectNotedData> | null;
    if (!data || typeof data.text !== 'string') continue;
    state.revision = event.seq;
    switch (data.kind) {
      case 'outcome':
        state.outcome = data.text;
        break;
      case 'decision':
        decisions.set(event.seq, { seq: event.seq, at: event.timestamp, text: data.text, by: data.by === 'user' ? 'user' : 'coordinator' });
        // A correction states what it replaces. Everything it names leaves
        // the active set now, so the two never bind at once.
        if (Array.isArray(data.supersedes)) {
          for (const target of data.supersedes) if (typeof target === 'number') retire(target, event, data.text);
        }
        break;
      case 'retire':
        // A decision withdrawn with nothing put in its place.
        if (Array.isArray(data.supersedes)) {
          for (const target of data.supersedes) if (typeof target === 'number') retire(target, event, data.text);
        }
        break;
      case 'priority':
        state.priority = {
          seq: event.seq,
          at: event.timestamp,
          text: data.text,
          thread: typeof data.ref === 'number' ? data.ref : null,
        };
        break;
      case 'open': {
        const thread: ProjectOpenThread = {
          seq: event.seq,
          at: event.timestamp,
          text: data.text,
          summary: null,
          evidence: [],
          owner: null,
          nextAction: null,
          waitingOn: null,
          workers: [],
          events: [],
          updatedAt: event.timestamp,
          waitingSince: event.timestamp,
        };

        applyThreadFields(thread, data, event.timestamp);
        // An `open` that says nothing about readiness has not been
        // reconciled; only an owner makes `waitingOn: null` mean ready.
        if (!('waitingOn' in data)) thread.waitingOn = null;
        threads.set(event.seq, thread);
        for (const worker of thread.workers) workerThread.set(worker, event.seq);
        break;
      }
      case 'update': {
        if (typeof data.ref !== 'number') break;
        const thread = threads.get(data.ref);
        if (!thread || thread.closedAt !== undefined) break;
        applyThreadFields(thread, data, event.timestamp);
        // An update's text is where the work has got to. It used to be
        // discarded, so the only durable account of a thread was its next
        // action and whatever a reader could infer from that.
        if (data.text.trim()) thread.summary = data.text.trim();
        thread.updatedAt = event.timestamp;

        // Naming a worker on an update attaches it here, the same as `open`
        // does. Attaching only the ones the thread had never listed would
        // leave a worker that went to another thread and came back writing
        // its reports against the thread it left.
        if (Array.isArray(data.workers)) {
          for (const worker of data.workers) {
            if (typeof worker === 'string' && worker) workerThread.set(worker, thread.seq);
          }
        }
        if (Array.isArray(data.addresses)) {
          for (const seq of data.addresses) if (typeof seq === 'number') discharge(seq);
        }
        break;
      }
      case 'close': {
        if (typeof data.ref !== 'number') break;
        const thread = threads.get(data.ref);
        if (!thread || thread.closedAt !== undefined) break;
        thread.closedAt = event.timestamp;
        thread.updatedAt = event.timestamp;
        if (data.text) thread.resolution = data.text;
        if (Array.isArray(data.addresses)) {
          for (const seq of data.addresses) if (typeof seq === 'number') discharge(seq);
        }
        // Closing a thread accounts for the events written on it up to this
        // point. Events the same worker wrote on another thread are not
        // this thread's to close, so they stay pending.
        for (const threadEvent of thread.events) {
          if (threadEvent.seq <= event.seq) discharge(threadEvent.seq);
        }
        // The workers are no longer carrying it; what they write next is
        // attributed to whatever thread they are attached to then.
        for (const worker of thread.workers) {
          if (workerThread.get(worker) === thread.seq) workerThread.delete(worker);
        }
        // A priority names the work to get on with; the work is over.
        if (state.priority?.thread === thread.seq) state.priority = null;
        closedOrder.push(thread.seq);
        break;
      }

      case 'accounting':
        // One boundary per coordinator: the first one is the record, and a
        // second note cannot move it and quietly unaccount what came after.
        if (accountingFrom === null) accountingFrom = event.seq;
        break;
      case 'reconcile': {
        // Only a pre-boundary event, and only one the coordinator named by
        // seq. There is no blanket clear and nothing is read out of prose.
        if (!Array.isArray(data.addresses)) break;
        for (const seq of data.addresses) {
          if (typeof seq !== 'number') continue;
          const item = historical.get(seq);
          if (!item) continue;
          historical.delete(seq);
          if (data.disposition === 'open') {
            // Still real work, and it starts waiting now rather than
            // backdated to a report nobody was accounting for.
            pending.set(seq, { ...item, since: event.timestamp, reconciledAt: event.timestamp });
          } else {
            const threadEvent = threadEvents.get(seq);
            if (threadEvent) threadEvent.addressed = true;
          }
        }
        break;
      }
      case 'now':
        state.now = data.text;
        break;
      default:
        break;
    }
  }

  for (const thread of threads.values()) {
    if (thread.closedAt === undefined) state.open.push(thread);
  }
  state.closed = closedOrder.map((seq) => threads.get(seq)).filter((thread): thread is ProjectOpenThread => Boolean(thread));
  state.attention = [...pending.values()].sort((a, b) => a.seq - b.seq);
  state.historical = [...historical.values()].sort((a, b) => a.seq - b.seq);
  state.decisions = [...decisions.values()].filter((decision) => !retired.has(decision.seq));
  state.retired = [...retired.values()].sort((a, b) => a.seq - b.seq);
  state.accountingFrom = accountingFrom;
  return state;
}


/**
 * Whether the turn that just ended left the record behind. Two ways it can:
 * it dispatched or answered a worker and wrote no note at all, or it ended
 * with a worker's report or question — one that was already waiting when the
 * turn began — still unaccounted for. Reading a message from the user does
 * not count on its own: a question answered in conversation need not be a
 * decision.
 *
 * The second case is the one the old check missed. A coordinator that read a
 * report, wrote `--now "reading the report"` and moved on satisfied it
 * (proved by probe, 2026-09-20), which is how a worker's finding could be
 * delivered, acknowledged and dropped.
 */
export function turnLeftStateStale(events: readonly ProjectEventLike[]): boolean {
  return unaddressedAfterTurn(events).stale;
}

export interface TurnStaleness {
  stale: boolean;
  /** Worker events that were waiting before the turn began and still are. */
  pending: PendingAttention[];
  /** The turn changed the roster and wrote no note at all. */
  unnoted: boolean;
}

export function unaddressedAfterTurn(events: readonly ProjectEventLike[]): TurnStaleness {
  let lastInput = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'input:sent') { lastInput = i; break; }
  }
  const turn = events.slice(lastInput + 1);
  // A worker moved in from another project was not this turn's doing.
  const changed = turn.some((event) => (event.type === 'worker:started' && !(event.data as { movedFrom?: unknown } | null)?.movedFrom)
    || event.type === 'worker:answered');
  const noted = turn.some((event) => event.type === PROJECT_NOTED_EVENT);
  const unnoted = changed && !noted;

  // Only what was already waiting when the turn started: a report that
  // arrived mid-turn has not had a turn to be handled in yet.
  const inputSeq = lastInput >= 0 ? events[lastInput].seq : Infinity;
  const pending = foldProjectState(events).attention.filter((item) => item.seq < inputSeq);
  return { stale: unnoted || pending.length > 0, pending, unnoted };
}

function renderOwner(owner: ThreadOwner, user: string): string {
  switch (owner.kind) {
    case 'coordinator': return 'you';
    case 'user': return user;
    case 'worker': return owner.worker;
    case 'external': return owner.who;
  }
}

function renderWait(wait: ThreadWait): string {
  const target = wait.worker ?? (wait.thread !== undefined ? `thread [${wait.thread}]` : null);
  return `waiting on ${wait.kind}${target ? ` ${target}` : ''}: ${wait.text}`;
}

function renderThread(thread: ProjectOpenThread, user: string): string[] {
  const lines = [`- [${thread.seq}] ${thread.text}`];
  // Where it has got to comes before what happens next: a reader deciding
  // anything about this thread needs the established fact first.
  if (thread.summary) lines.push(`  so far: ${thread.summary}`);
  // `?? []` for the same reason `events` has it below: for the length of an
  // activation the CLI is newer than the server it is talking to, and the
  // running one answers with a shape that predates these fields.
  const evidence = thread.evidence ?? [];
  if (evidence.length > 0) lines.push(`  evidence: ${evidence.join('; ')}`);

  const detail: string[] = [];
  detail.push(thread.owner ? `owner ${renderOwner(thread.owner, user)}` : 'no owner noted');
  if (thread.nextAction) detail.push(`next: ${thread.nextAction}`);
  else if (thread.owner) detail.push('no next action noted');
  detail.push(thread.waitingOn ? renderWait(thread.waitingOn) : 'ready');
  lines.push(`  ${detail.join(' · ')}`);

  // A CLI is newer than the server it is talking to for the length of an
  // activation: the running server may still be answering with a shape that
  // predates threads, where an entry has no events at all. Rendering what it
  // did send beats dying on what it did not — front hit this on a `note
  // --now`, where the crash came after the write and made a mutation that had
  // landed look like it had failed (2026-09-20).
  const unaddressed = (thread.events ?? []).filter((event) => !event.addressed);
  for (const event of unaddressed) {
    lines.push(`  [${event.seq}] ${event.kind} from ${event.worker}, not yet accounted for: ${event.firstLine}`);
  }
  return lines;
}

export interface RenderProjectStateOptions {
  /**
   * Also print what is no longer active: the decisions that were replaced or
   * retired, the closed threads, and the reports from before accounting
   * started. Off by default, which is what makes this projection small enough
   * to put in front of every turn.
   */
  history?: boolean;
  /** The CLI to name in the pointers to history; omitted, they are left out. */
  cli?: string;
  /** The conversation the history commands would be run against. */
  conversationId?: string;
  /** What to call the user in the text; defaults to "the user". */
  userName?: string;
}

/**
 * The written state as text. By default this is the *active* projection —
 * what is currently true and currently binding — and it is the same text
 * everywhere: `session state`, the restore block after a compaction, the
 * orientation put in front of an ordinary or report-driven turn, and what
 * the fast responder answers from.
 *
 * What it leaves out is as deliberate as what it keeps. A project that has
 * run for a while accumulates a decision and its correction, threads it has
 * finished, and reports written before anything recorded a disposition:
 * front's own record folded to 58 decisions and 49 such reports, 24KB of
 * text, most of it no longer instructions. Those stay retrievable — nothing
 * is deleted and their provenance survives — and `history: true` prints them.
 */
export function renderProjectState(state: ProjectState, options: RenderProjectStateOptions = {}): string {
  const user = options.userName ?? 'the user';
  const lines: string[] = [];
  const retired = state.retired ?? [];
  const closed = state.closed ?? [];
  const historical = state.historical ?? [];
  lines.push(`Outcome: ${state.outcome ?? '(not noted yet)'}`);
  if (state.priority) {
    const where = state.priority.thread !== null ? ` (thread [${state.priority.thread}])` : '';
    lines.push(`Priority: ${state.priority.text}${where}`);
  }
  if ((state.decisions ?? []).length > 0) {
    lines.push('Decisions in force:');
    for (const decision of state.decisions) {
      lines.push(`- [${decision.seq}] ${decision.text}${decision.by === 'user' ? ` (${user}'s call)` : ''}`);
    }
  } else {
    lines.push('Decisions in force: none noted.');
  }
  if ((state.open ?? []).length > 0) {
    lines.push('Open threads:');
    for (const thread of state.open) lines.push(...renderThread(thread, user));
  } else {
    lines.push('Open threads: none.');
  }
  if ((state.attention ?? []).length > 0) {
    lines.push(`Waiting on your disposition (${state.attention.length}):`);
    for (const item of state.attention) {
      const where = item.thread === null ? 'no thread' : `thread [${item.thread}]`;
      const reopened = item.reconciledAt !== undefined ? ', reopened when you reconciled it' : '';
      lines.push(`- [${item.seq}] ${item.kind} from ${item.worker} (${where}${reopened}): ${item.firstLine}`);
    }
  }
  if (state.now) lines.push(`Now: ${state.now}`);

  if (!options.history) {
    const counts: string[] = [];
    if (retired.length > 0) counts.push(`${retired.length} decision${retired.length === 1 ? '' : 's'} no longer in force`);
    if (closed.length > 0) counts.push(`${closed.length} closed thread${closed.length === 1 ? '' : 's'}`);
    if (historical.length > 0) counts.push(`${historical.length} report${historical.length === 1 ? '' : 's'} from before accounting started`);
    if (counts.length > 0) {
      const how = options.cli && options.conversationId
        ? ` — \`${options.cli} session state ${options.conversationId} --history\``
        : ' — `session state <conv> --history`';
      lines.push(`History, kept and not shown here: ${counts.join(', ')}${how}`);
    }
    return lines.join('\n');
  }

  if (retired.length > 0) {
    lines.push('Decisions no longer in force (kept; what replaced or withdrew each is in brackets):');
    for (const decision of retired) {
      lines.push(`- [${decision.seq}] ${decision.text}${decision.by === 'user' ? ` (${user}'s call)` : ''}`);
      lines.push(`  [${decision.retiredBy}] ${decision.reason}`);
    }
  }
  if (closed.length > 0) {
    lines.push('Closed threads:');
    for (const thread of closed) {
      lines.push(`- [${thread.seq}] ${thread.text}${thread.resolution ? ` — ${thread.resolution}` : ''}`);
    }
  }
  if (historical.length > 0) {
    lines.push(
      `From before this project started accounting for worker results (${historical.length}), disposition unknown —`,
      'these are not overdue, and nothing will remind you about them. Say what happened to one with',
      '`note --reconcile <seq> --as handled|superseded|open --with "<what actually happened>"`:',
    );
    for (const item of historical) {
      lines.push(`- [${item.seq}] ${item.kind} from ${item.worker}: ${item.firstLine}`);
    }
  }
  return lines.join('\n');
}

/**
 * Thread references such as "(thread [948])" or "[15324]" are ids the
 * coordinator writes for itself; the sidebar shows the words only.
 */
export function withoutThreadRefs(text: string): string {
  return text
    .replace(/\s*\((?:threads?\s*)?\[\d+\](?:\s*(?:,|and)\s*\[\d+\])*\)/gi, '')
    .replace(/\s*\[\d+\]/g, '')
    .trim();
}
