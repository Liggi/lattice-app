/**
 * The coordinator router: when a coordinator is mid-turn, does this message
 * need a reply before the turn finishes? That is the only question it
 * answers. Everything else waits in the inbox for the full responder, which
 * has the context to decide whether an item is a decision to think about or
 * a task to park; a router making that call would be second-guessing the
 * coordinator with less information.
 *
 * Jev (TypeSafe's criterion judge) answers it as a probability over the
 * last few thread turns, the `now` line and the message. The threshold is
 * the one calibrated on real coordinator inputs (2026-09-20, see the
 * constant). Jev unavailable → not routed: a missing router degrades to
 * today's behaviour (the message waits), never to a wrong route.
 */

import { ConfigService } from '../infrastructure/config-service.js';
import { createLogger } from '../infrastructure/logger.js';
import { judgeNoul, type NoulQuestion } from '../infrastructure/typesafe-client.js';
import { getHarnessSessionManager } from '../../harness/setup.js';
import { appendCustomHarnessEvent } from '../../harness/harness-custom-events.js';
import { getEvents } from '../../session-history/repository.js';
import { foldProjectState } from '../../types/project-state.js';
import { COORDINATOR_ROUTED_EVENT, type CoordinatorRoutedData } from '../../types/coordinator-reply.js';
import { renderRecentThread } from './coordinator-thread.js';
import { userName, UserName } from '../user-profile.js';

const logger = createLogger('CoordinatorRouter');

/** Thread turns the judge sees; enough to know what the coordinator is in the middle of. */
export const ROUTER_THREAD_TURNS = 3;
/** Jev's measured median is ~340ms direct; this is the ceiling before the message just waits. */
export const ROUTER_TIMEOUT_MS = 4000;
/**
 * Calibrated 2026-09-20 on 102 hand-labelled inputs from 36 real coordinator
 * sessions (`abc-jev-eval/router-calibration-2026-09-20`): precision 0.82,
 * recall 0.95. Jev's scores sit in a narrow band (state questions such as
 * "what are you working on right now?" land at 0.42–0.59), so 0.5 misses
 * the cases the fast responder exists for; the extra false positives at
 * 0.4 are questions that need a look, which the responder answers with
 * "can't tell yet". Overridable per deployment:
 * `coordinator.fastReply.threshold`.
 *
 * The wording below gained its telling-vs-asking paragraph after two live
 * misroutes (a bug report at 0.49, a restatement of what the user wants at 0.45).
 * Re-scoring the same 102 samples with it gives the same table at 0.4
 * (prec 0.82, rec 0.95, 8 FP, 2 FN), and drops those two to 0.41 and 0.32.
 */
export const DEFAULT_ROUTER_THRESHOLD = 0.4;

export const ROUTER_QUESTION: NoulQuestion = {
  instructions: [
    'The coordinator is an AI agent mid-way through a turn of work (its current activity is the `Now` line, when present).',
    `${UserName()} has just sent it the message marked [message]. The coordinator will read the message when its turn ends.`,
    `Does this message need a reply before the coordinator finishes what it is doing? Yes when ${userName()} is asking`,
    'something they need answered now: a question about what is happening, what was decided or what something',
    'means; a request to explain, walk through, catch them up or map out what has been done and why; asking',
    'whether to do something or what could go wrong; or asking for options or a pitch to react to. Waiting for',
    'the turn to end would leave them stuck or guessing. No when the message is new work, a note for later, a',
    'decision or instruction the coordinator should act on, a correction to the work in progress, a bug report,',
    'or an acknowledgement or go-ahead, even one phrased as a question.',
    `The test is whether ${userName()} is asking the coordinator something or telling it something. Telling it covers`,
    'more than instructions: reporting a fault they have just seen in the product, saying what they do or does not',
    'want built, and repeating feedback they feel was not taken ("again - ...") all describe what is happening or',
    'what they want, so they can read like questions about the state of things. They are not. The answer they need',
    'is what the coordinator will do about it, and that can only come once the turn ends.',
  ].join(' '),
  criteria: {
    true: `${UserName()} needs an answer to this message before the coordinator finishes its current turn.`,
    false: 'This message can wait for the coordinator to finish its current turn; it is work, an instruction, a note, or an acknowledgement.',
  },
};

export interface RouterInput {
  thread: string;
  now: string | null;
  message: string;
}

/** The state Jev judges, built the same way for calibration and live. Exported for the calibration script and tests. */
export function renderRouterState(input: RouterInput): string {
  return [
    `Recent thread between ${userName()} and the coordinator, oldest first:`,
    input.thread,
    '',
    `Now: ${input.now ?? '(the coordinator has not said what this turn is doing)'}`,
    '',
    '[message]',
    input.message,
  ].join('\n');
}

export function routerThreshold(): number {
  try {
    const configured = ConfigService.getInstance().getConfig().coordinator?.fastReply?.threshold;
    if (typeof configured === 'number' && configured > 0 && configured < 1) return configured;
  } catch {
    // Before initialize(): the default.
  }
  return DEFAULT_ROUTER_THRESHOLD;
}

export interface RouteVerdict {
  needsReplyNow: boolean;
  score: number | null;
  threshold: number;
  ms: number;
  error?: string;
}

/**
 * Judge one message to a busy coordinator. Never throws; a failure is a
 * verdict of "wait" with the error recorded. The verdict is appended to the
 * coordinator's log as `coordinator:routed` by the caller once it knows the
 * inbox id, so the count of routes and misses is visible.
 */
export async function routeCoordinatorMessage(conversationId: string, message: string): Promise<RouteVerdict> {
  const events = getEvents(conversationId);
  const state = renderRouterState({
    thread: renderRecentThread(events, ROUTER_THREAD_TURNS),
    now: foldProjectState(events).now,
    message,
  });
  const threshold = routerThreshold();
  const started = Date.now();
  try {
    const answer = await judgeNoul(state, ROUTER_QUESTION, { timeoutMs: ROUTER_TIMEOUT_MS });
    const needsReplyNow = answer.noul >= threshold;
    logger.info('Routed message to a busy coordinator', { conversationId, score: answer.noul, threshold, needsReplyNow, ms: answer.ms });
    return { needsReplyNow, score: answer.noul, threshold, ms: answer.ms };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn('Router unavailable; message waits for the turn', { conversationId, error });
    return { needsReplyNow: false, score: null, threshold, ms: Date.now() - started, error };
  }
}

export function recordRoute(conversationId: string, verdict: RouteVerdict, inboxId?: string): void {
  const manager = getHarnessSessionManager();
  if (!manager) return;
  appendCustomHarnessEvent(manager, conversationId, COORDINATOR_ROUTED_EVENT, {
    ...(inboxId ? { inboxId } : {}),
    needsReplyNow: verdict.needsReplyNow,
    score: verdict.score,
    threshold: verdict.threshold,
    ms: verdict.ms,
    ...(verdict.error ? { error: verdict.error } : {}),
  } satisfies CoordinatorRoutedData);
}
