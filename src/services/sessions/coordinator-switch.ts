/**
 * Moving a coordinator to another provider without leaving its conversation.
 *
 * The conversation id is the project: workers are picked up from it, report
 * into its inbox and appear in its log, and its project record is folded from
 * that log. So a coordinator changes model by gaining a segment, not by being
 * replaced. What cannot move is the provider's own context — a Codex thread
 * cannot be resumed by Claude, and Codex keeps its compaction summary on its
 * side (the log holds only `context:compaction` markers) — so the new model's
 * first turn is a handover built from the server's records: the standing
 * preamble and worker roster the compaction restore uses, the full project
 * state, and the most recent exchanges verbatim, with the CLI commands that
 * reach everything older.
 *
 * Safety comes from three things. The switch holds the session's turn
 * admission from before its first check to after its last write, so a send,
 * a drain or a compaction either finished before it or waits for it — a
 * worker report arriving meanwhile queues behind it and goes to the new
 * model exactly once, through the inbox as any report does. It refuses
 * unless the coordinator is idle with nothing in its inbox and no background
 * task. And "switched" means the target model has answered the handover turn,
 * not merely that a process started: until then the old provider is what a
 * rollback restores, because the harness respawns from the last `run:start`
 * it recorded, whatever the segment says. The log records `requested`, then
 * `completed` or `failed`, so a request is never mistaken for a switch.
 */

import type { SessionManager, SpawnConfig } from '@liggi/agent-ui-harness/server';
import { hasRunningBackgroundTasks, type SessionEvent } from '@liggi/agent-ui-harness/protocol';
import { appendCustomHarnessEvent } from '../../harness/harness-custom-events.js';
import { getEvents } from '../../session-history/repository.js';
import { projectTranscript } from '../../session-history/renderer.js';
import type { RawEvent } from '../../session-history/types.js';
import { CLAUDE_MODELS } from '../../constants/claude-models.js';
import { supersededModelRefusal } from '../../constants/superseded-models.js';
import {
  SERVER_NOTE_END,
  SERVER_NOTE_PREFIX,
  isWorkerInput,
  stripContextRestore,
  stripPreamble,
} from '../../types/worker-events.js';
import type { ActiveConversationRegistry } from '../process/active-conversation-registry.js';
import { createLogger } from '../infrastructure/logger.js';
import type { ConversationSegment, ConversationService, Provider } from './conversation-service.js';
import { buildCoordinatorTakeoverBlock } from './context-compaction.js';
import { composeProjectOrientation, recordProjectOrientation, type ProjectOrientedData } from './project-orientation.js';
import { drainInbox, hasUnreadInboxItems } from './session-inbox.js';
import { tryAdmitTurn } from './turn-admission.js';
import {
  COORDINATOR_SWITCH_EVENT,
  PENDING_SWITCH_PREFIX,
  label,
  unfinishedSwitch,
  type CoordinatorSwitchData,
  type SwitchTarget,
  type UnfinishedSwitch,
} from './coordinator-switch-state.js';
import { userName } from '../user-profile.js';

export { COORDINATOR_SWITCH_EVENT, unfinishedSwitch, unfinishedSwitchRefusal } from './coordinator-switch-state.js';
export type { CoordinatorSwitchData, SwitchTarget, UnfinishedSwitch } from './coordinator-switch-state.js';

const logger = createLogger('CoordinatorSwitch');


/** How many of the user's own messages the handover carries in full, with everything said after the first of them. */
const RECENT_USER_MESSAGES = 3;
const DEFAULT_TIMEOUT_MS = 180_000;
const KILL_WAIT_MS = 10_000;



export type SwitchResult =
  | { status: 'switched'; conversationId: string; from: SwitchTarget; to: SwitchTarget; segmentId: string; reply: string }
  | { status: 'unchanged'; conversationId: string; provider: Provider; model: string | null }
  /** An unfinished switch was undone and the previous provider started again; nothing was switched. */
  | { status: 'rolled-back'; conversationId: string; provider: Provider; model: string | null; error: string }
  | { status: 'refused'; code: SwitchRefusal; reason: string }
  | { status: 'failed'; conversationId: string; error: string; restored: boolean };

export type SwitchRefusal =
  | 'not-found' | 'not-coordinator' | 'unsupported' | 'unknown-model' | 'same-provider'
  | 'busy' | 'not-idle' | 'inbox-pending' | 'background-task' | 'no-provider-session';

export interface CoordinatorSwitchDeps {
  sessionManager: SessionManager;
  conversationService: ConversationService;
  registry: ActiveConversationRegistry;
  cli: string;
  /** Claude spawn settings the create route uses: hooks synced, permission mode, system prompt. */
  claudeSpawn: () => { permissionMode: string; systemPrompt?: string };
  /** The Codex config a resume of this conversation would use; the rollback target. */
  codexResumeConfig: (conversationId: string, segment: ConversationSegment) => SpawnConfig;
  timeoutMs?: number;
  /** Delivers what the inbox holds; the real drain unless a test replaces it. */
  drain?: (conversationId: string) => Promise<void>;
}

function refused(code: SwitchRefusal, reason: string): SwitchResult {
  return { status: 'refused', code, reason };
}


/**
 * The last few of the user's messages and everything after the first of them,
 * verbatim. Server blocks are taken off the user side — the handover carries
 * the current copy of what they said — and the first message's preamble with
 * them; nothing else is shortened.
 */
export function renderRecentExchanges(events: readonly RawEvent[]): { text: string; fromSeq: number | null } {
  const inputs = events.filter((event) => event.type === 'input:sent'
    && (event.data as { source?: string })?.source !== 'command');
  const own = inputs.filter((event) => {
    const text = stripPreamble(stripContextRestore((event.data as { text?: string })?.text ?? '')).trim();
    return text.length > 0 && !isWorkerInput(text);
  });
  const first = own.length > RECENT_USER_MESSAGES ? own[own.length - RECENT_USER_MESSAGES] : inputs[0];
  if (!first) return { text: '(no exchanges yet)', fromSeq: null };
  const lines = projectTranscript(events.filter((event) => event.seq >= first.seq))
    .map((line) => (line.role === 'user' ? { ...line, text: stripPreamble(stripContextRestore(line.text)) } : line))
    .filter((line) => line.text.trim().length > 0);
  const text = lines
    .map((line) => {
      const ref = line.endSeq !== undefined && line.endSeq !== line.seq ? `${line.seq}-${line.endSeq}` : `${line.seq}`;
      return `[${ref}] ${line.role === 'user' ? 'input' : line.role}: ${line.text}`;
    })
    .join('\n\n');
  return { text, fromSeq: first.seq };
}

/**
 * Everything the new model's first turn is given, and the orientation receipt
 * to record once it has been read — not before: a handover that never reached
 * the model has shown it nothing. Exported for the tests.
 */
export function buildHandover(
  conversationId: string,
  from: SwitchTarget | { provider: Provider; model: string | null },
  to: SwitchTarget,
  cli: string,
): { text: string; oriented: ProjectOrientedData | null } {
  // Three server notes back to back, each closed by its own end marker, so
  // the thread strips all of them and shows this input as nothing the user said.
  const takeover = buildCoordinatorTakeoverBlock(conversationId, [
    `${SERVER_NOTE_PREFIX} This conversation has just moved from ${label(from.provider, from.model)} to ${label(to.provider, to.model)}.`,
    'You hold none of the previous model\'s context. What follows is your standing preamble and the state of your workers from',
    'the server\'s records; then the project record; then the most recent exchanges verbatim and how to read everything older.]',
  ], SERVER_NOTE_END);
  const orientation = composeProjectOrientation(conversationId, cli, { switched: true });
  const recent = renderRecentExchanges(getEvents(conversationId, { types: ['input:sent', 'content'] }));
  const session = `${cli} session`;
  const older = recent.fromSeq !== null && recent.fromSeq > 1
    ? `Everything before event ${recent.fromSeq} is not in this handover.`
    : 'The exchanges below are the whole conversation so far.';
  const history = [
    `${SERVER_NOTE_PREFIX} The most recent exchanges in this conversation, verbatim from its log; the numbers are event refs.`,
    'They are history, not new messages: whatever was asked in them was asked of the previous model, and whether it was',
    'done is in the record above and in what was said after it.',
    '',
    `The whole history is still here, under this same conversation id (${conversationId}), the previous model's turns included.`,
    `${older} When something you need is not in the record or below, look it up rather than assume it:`,
    `- \`${session} grep ${conversationId} <words>\` finds where something was said or done (--role user|assistant|tool narrows it).`,
    `- \`${session} transcript ${conversationId} --from <seq> --to <seq>\` reads what was said in a range; --last N keeps the`,
    '  newest N. With neither it prints only the last 50 turns, so give a range for anything older.',
    `- \`${session} inputs ${conversationId}\` lists what came in, ${userName()}'s messages and worker reports; it takes the same range flags.`,
    `- \`${session} tools ${conversationId} [--name <tool>]\` lists tool calls; \`${session} event ${conversationId} <seq>\` prints one event`,
    '  in full, including a report the record cites by seq.',
    `- \`${session} state ${conversationId} --history\` adds retired decisions, closed threads and older reports to the record.`,
    `- \`${session} workers ${conversationId}\` lists the workers; \`${session} transcript <worker> --last N\` and`,
    `  \`${session} grep <worker> <words>\` read a worker's own words.`,
    '',
    recent.text,
    '',
    `This turn is the handover itself, not a request. Reply with the single line "Now running on ${to.model}; I have the record and`,
    'the recent exchanges." and take no other action. The next message is the one to act on.',
    SERVER_NOTE_END,
    '',
  ].join('\n');
  return { text: takeover + (orientation?.text ?? '') + history, oriented: orientation?.shown ?? null };
}

/** Resolves when the target model has answered the handover turn; rejects on anything else. */
function awaitServedTurn(
  sessionManager: SessionManager,
  sessionId: string,
  isNewRun: (event: SessionEvent) => boolean,
  model: string,
  timeoutMs: number,
  seen: SessionEvent[],
): { promise: Promise<{ reply: string; resumeId: string }>; cancel: () => void } {
  const log = sessionManager.getLog(sessionId);
  let cancel = (): void => {};
  const promise = new Promise<{ reply: string; resumeId: string }>((resolve, reject) => {
    if (!log) { reject(new Error('Session has no event log')); return; }
    let ready = false;
    let resumeId = '';
    let served = false;
    let reply = '';
    let done = false;
    const finish = (err: Error | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      if (err) reject(err); else resolve({ reply, resumeId });
    };
    const onEvent = (event: SessionEvent): void => {
      if (!isNewRun(event)) return;
      const data = event.data as Record<string, unknown>;
      if (event.type === 'run:ready') {
        ready = typeof data.resumeId === 'string' && !data.resumeId.startsWith('pending-');
        if (ready) resumeId = data.resumeId as string;
      } else if (event.type === 'content' && ready) {
        const servedBy = typeof data.model === 'string' ? data.model : '';
        if (!data.parentToolUseId && servedBy.startsWith(model)) {
          served = true;
          for (const block of (data.blocks as Array<{ type: string; text?: string }> | undefined) ?? []) {
            if (block.type === 'text' && block.text) reply += block.text;
          }
        }
      } else if (event.type === 'turn:end') {
        finish(served ? null : new Error(`the handover turn ended without a reply from ${model}`));
      } else if (event.type === 'run:error') {
        finish(new Error(typeof data.message === 'string' ? data.message : 'the new run failed'));
      } else if (event.type === 'run:end') {
        finish(new Error('the new process exited before answering the handover'));
      }
    };
    const timer = setTimeout(() => finish(new Error(`no reply from ${model} within ${timeoutMs}ms`)), timeoutMs);
    const unsubscribe = log.subscribe(onEvent);
    cancel = () => finish(new Error('cancelled'));
    for (const event of seen) onEvent(event);
  });
  return { promise, cancel };
}

async function killRun(sessionManager: SessionManager, sessionId: string): Promise<void> {
  if (!sessionManager.inspect(sessionId)?.processAlive) return;
  const log = sessionManager.getLog(sessionId);
  const exited = new Promise<void>((resolve) => {
    if (!log) { resolve(); return; }
    const unsubscribe = log.subscribe((event) => {
      if (event.type === 'run:end') { unsubscribe(); resolve(); }
    });
    setTimeout(() => { unsubscribe(); resolve(); }, KILL_WAIT_MS);
  });
  sessionManager.signal(sessionId, 'SIGKILL');
  await exited;
}

/**
 * Move a coordinator to `target`. Refuses rather than waits: a busy
 * coordinator is switched at a later idle moment by calling again.
 */
export async function switchCoordinator(
  conversationId: string,
  target: SwitchTarget,
  deps: CoordinatorSwitchDeps,
): Promise<SwitchResult> {
  const { sessionManager, conversationService, registry, cli } = deps;

  const admission = tryAdmitTurn(conversationId, 'switch');
  if (!admission) return refused('busy', 'Another send, delivery or compaction holds this conversation\'s next turn. Try again when it is idle.');
  let drainAfter = false;
  try {
    const conversation = conversationService.getConversation(conversationId);
    if (!conversation) return refused('not-found', `Conversation ${conversationId} not found`);
    if (!conversation.coordinator) return refused('not-coordinator', 'Only a project coordinator can be switched this way.');

    // An unfinished switch is undone before anything else, whatever this call
    // asks for: which provider the harness would respawn is not known, so
    // the previous one is started again and that is all this call does.
    const unfinished = unfinishedSwitch(conversationId, conversationService);
    if (unfinished) {
      const result = await rollBack(conversationId, conversation, unfinished, deps);
      // Messages kept while the switch was unfinished go to the provider now running.
      drainAfter = result.status === 'rolled-back';
      return result;
    }

    if (target.provider !== 'claude') return refused('unsupported', 'Only a switch to Claude is supported.');
    if (!CLAUDE_MODELS.some((entry) => entry.id === target.model)) {
      return refused('unknown-model', `${target.model} is not in the Claude model registry.`);
    }
    const superseded = supersededModelRefusal(target.model);
    if (superseded) return refused('unknown-model', superseded);

    const previous = conversationService.getLatestSegment(conversationId);
    if (!previous) return refused('not-found', `Conversation ${conversationId} has no segments`);
    if (previous.provider === target.provider) {
      if (previous.model === target.model) {
        return { status: 'unchanged', conversationId, provider: previous.provider, model: previous.model };
      }
      return refused('same-provider', `Already on ${previous.provider}. A model change within a provider keeps the provider's own transcript: send the next message with --model ${target.model}.`);
    }
    if (previous.providerSessionId.startsWith('pending-')) {
      return refused('no-provider-session', `The ${previous.provider} session has not started yet, so there is nothing to fall back to.`);
    }

    if (!sessionManager.hasSession(conversationId)) sessionManager.recoverFromStorage(conversationId);
    const diagnostics = sessionManager.inspect(conversationId);
    if (diagnostics && diagnostics.status !== 'idle') {
      return refused('not-idle', `The coordinator is ${diagnostics.status}. Switch it between turns.`);
    }
    if (diagnostics?.scheduledWakeup) return refused('not-idle', 'The coordinator has a scheduled wakeup pending.');
    const log = sessionManager.getLog(conversationId);
    if (log && hasRunningBackgroundTasks(log.all())) {
      return refused('background-task', 'The coordinator has a background task running.');
    }
    if (hasUnreadInboxItems(conversationId)) {
      return refused('inbox-pending', 'The coordinator has unread messages or a delivery in progress. Switch it after they are read.');
    }

    const from = { provider: previous.provider, model: previous.model };
    // Built before anything changes, so a failure here refuses rather than
    // leaving a half-made switch. It writes nothing; the orientation receipt
    // is recorded once the new model has read it.
    const handover = buildHandover(conversationId, from, target, cli);

    // From here until `completed` or `failed`, the segment's pending id (until
    // run:ready) or the `requested` event (after it) marks the switch as
    // unfinished, so a server that stops in between leaves it blocked and
    // undoable rather than looking done (unfinishedSwitch).
    const { segmentId } = conversationService.addSegment(conversationId, {
      provider: target.provider,
      providerSessionId: `${PENDING_SWITCH_PREFIX}${Date.now()}`,
      model: target.model,
    });
    const record = (data: Omit<CoordinatorSwitchData, 'from' | 'to'>): void => {
      appendCustomHarnessEvent(sessionManager, conversationId, COORDINATOR_SWITCH_EVENT, {
        ...data,
        from: { ...from, segmentId: previous.segmentId },
        to: { ...target, segmentId },
      } satisfies CoordinatorSwitchData);
    };
    record({ phase: 'requested' });

    const spawn = deps.claudeSpawn();
    // Events the new run appends before its runId is known are kept here and
    // replayed into the waiter, which subscribes synchronously before this
    // collector is dropped, so none is missed or seen twice.
    const seen: SessionEvent[] = [];
    const collect = log?.subscribe((event) => { seen.push(event); });
    let waiter: ReturnType<typeof awaitServedTurn> | null = null;
    try {
      // No `resume`: the harness would otherwise hand Claude the Codex thread id.
      const started = await sessionManager.start(conversationId, {
        prompt: handover.text,
        cwd: conversation.workingDirectory,
        args: [`--model=${target.model}`, `--permission-mode=${spawn.permissionMode}`],
        extra: {
          sessionId: conversationId,
          provider: target.provider,
          workspace: conversation.workspace || 'main',
          ...(spawn.systemPrompt ? { systemPrompt: spawn.systemPrompt } : {}),
        },
      });
      const newRun = started.runId;
      waiter = awaitServedTurn(sessionManager, conversationId, (event) => event.runId === newRun, target.model, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, seen);
      collect?.();
      const { reply, resumeId } = await waiter.promise;

      // run:ready's own handler normally replaces the pending id; a switch is
      // not complete with the placeholder still there, so it does not rely on that.
      conversationService.updateSegmentProviderSessionId(conversationId, resumeId);
      if (started.processId) conversationService.updateSegmentStreamingId(segmentId, started.processId);
      const segment = conversationService.getLatestSegment(conversationId)!;
      registry.register({
        conversationId,
        segment: {
          segmentId,
          provider: target.provider,
          providerSessionId: segment.providerSessionId,
          model: target.model,
          transitionReason: 'provider_switch',
        },
        run: started.processId ? {
          streamingId: started.processId,
          runVersion: registry.allocateRunVersion(conversationId),
          startedAt: new Date().toISOString(),
        } : null,
        workingDirectory: conversation.workingDirectory,
        permissionMode: spawn.permissionMode,
      });
      if (handover.oriented) recordProjectOrientation(conversationId, handover.oriented);
      record({ phase: 'completed' });
      logger.info('Coordinator switched', { conversationId, from, to: target });
      return { status: 'switched', conversationId, from: { provider: from.provider, model: from.model ?? '' }, to: target, segmentId, reply };
    } catch (err) {
      collect?.();
      waiter?.cancel();
      const error = err instanceof Error ? err.message : String(err);
      logger.warn('Coordinator switch failed; restoring the previous provider', { conversationId, error });
      await killRun(sessionManager, conversationId);
      conversationService.discardLatestSegment(conversationId, segmentId);
      const restored = await restartPrevious(conversationId, conversation, previous, deps);
      record({ phase: 'failed', error, restored });
      return { status: 'failed', conversationId, error, restored };
    }
  } finally {
    admission.release();
    if (drainAfter) void (deps.drain ?? drainInbox)(conversationId);
  }
}

/**
 * The harness respawns from the last run:start it recorded, so the previous
 * provider has to be started again for it to be the one a later message
 * reaches. No prompt: it resumes its thread and waits. False if it would not
 * start, which leaves the switch unfinished and sends blocked.
 */
async function restartPrevious(
  conversationId: string,
  conversation: { workingDirectory: string },
  previous: ConversationSegment,
  deps: CoordinatorSwitchDeps,
): Promise<boolean> {
  const { sessionManager, conversationService, registry } = deps;
  try {
    const restart = await sessionManager.start(conversationId, deps.codexResumeConfig(conversationId, previous));
    if (restart.processId) conversationService.updateSegmentStreamingId(previous.segmentId, restart.processId);
    registry.register({
      conversationId,
      segment: {
        segmentId: previous.segmentId,
        provider: previous.provider,
        providerSessionId: previous.providerSessionId,
        model: previous.model ?? undefined,
        transitionReason: 'recovery',
      },
      run: restart.processId ? {
        streamingId: restart.processId,
        runVersion: registry.allocateRunVersion(conversationId),
        startedAt: new Date().toISOString(),
      } : null,
      workingDirectory: conversation.workingDirectory,
      permissionMode: 'codex-bypass',
    });
    return true;
  } catch (err) {
    logger.error('Previous provider did not restart', err instanceof Error ? err : new Error(String(err)), { conversationId });
    return false;
  }
}

/**
 * Undo an unfinished switch: stop whatever the new provider left running,
 * take its segment off if it is still the latest, and start the previous
 * provider again. Recorded as `failed`, so it is settled only if that start
 * worked; otherwise it stays unfinished and can be tried again.
 */
async function rollBack(
  conversationId: string,
  conversation: { workingDirectory: string; segments: ConversationSegment[] },
  unfinished: UnfinishedSwitch,
  deps: CoordinatorSwitchDeps,
): Promise<SwitchResult> {
  const { sessionManager, conversationService } = deps;
  const previous = conversation.segments.find((segment) => segment.segmentId === unfinished.fromSegmentId);
  if (!previous) return refused('no-provider-session', `The segment the unfinished switch came from (${unfinished.fromSegmentId}) is missing.`);
  if (previous.provider !== 'codex') {
    return refused('unsupported', `The unfinished switch came from ${previous.provider}, and only a Codex coordinator can be started again here.`);
  }
  if (!sessionManager.hasSession(conversationId)) sessionManager.recoverFromStorage(conversationId);
  await killRun(sessionManager, conversationId);
  if (unfinished.toSegmentId) conversationService.discardLatestSegment(conversationId, unfinished.toSegmentId);
  const restored = await restartPrevious(conversationId, conversation, previous, deps);
  const error = `undid an unfinished switch: ${unfinished.why}`;
  appendCustomHarnessEvent(sessionManager, conversationId, COORDINATOR_SWITCH_EVENT, {
    phase: 'failed',
    from: { provider: previous.provider, model: previous.model, segmentId: previous.segmentId },
    to: unfinished.to
      ? { ...unfinished.to, model: unfinished.to.model ?? '', segmentId: unfinished.toSegmentId ?? '' }
      : { provider: 'claude', model: '', segmentId: unfinished.toSegmentId ?? '' },
    error,
    restored,
  } satisfies CoordinatorSwitchData);
  logger.warn('Unfinished coordinator switch undone', { conversationId, restored, why: unfinished.why });
  if (!restored) return { status: 'failed', conversationId, error: `${error}; ${previous.provider} did not start again`, restored: false };
  return { status: 'rolled-back', conversationId, provider: previous.provider, model: previous.model, error };
}
