/**
 * The fast responder: one model call, no tools, answering a message that
 * the router said needs a reply while the coordinator is mid-turn.
 *
 * It reads the written project state, the worker roster, the last few
 * thread turns, the tool calls of the coordinator's current turn (what it
 * ran, never what came back) and the message, and answers from that, names the
 * specific thing it cannot see, or abstains (`NO_USEFUL_ANSWER`) when
 * neither would help. The reply is appended to the thread as
 * the coordinator's (`coordinator:replied`, `responder: 'fast'`) and stored
 * on the message's inbox row, so the full responder reads the exchange in
 * its next batch as context and carries on from it (correcting it only if
 * it was substantively wrong). While the reply is being written the
 * row is held out of the drain (`reply_pending`), so a turn ending in that
 * window does not take the message without its answer.
 *
 * Model: the strongest fast tier, `coordinator.fastReply.model`; this is
 * answering from state, not deciding.
 */

import { anthropicClientFactory } from '../infrastructure/anthropic-client-factory.js';
import { ConfigService } from '../infrastructure/config-service.js';
import { getCostTracker } from '../infrastructure/cost-tracker.js';
import { createLogger } from '../infrastructure/logger.js';
import { getHarnessSessionManager } from '../../harness/setup.js';
import { appendCustomHarnessEvent } from '../../harness/harness-custom-events.js';
import { getEvents } from '../../session-history/repository.js';
import { foldProjectState, renderProjectState } from '../../types/project-state.js';
import { COORDINATOR_REPLIED_EVENT, type CoordinatorRepliedData } from '../../types/coordinator-reply.js';
import { ConversationService } from './conversation-service.js';
import { renderWorkerRoster } from './context-compaction.js';
import { renderCurrentTurnActivity, renderRecentThread } from './coordinator-thread.js';
import { latticeCli, messageShapeGuidance } from './pickup-prompts.js';
import { drainInbox, enqueueInboxItem, setInboxReply } from './session-inbox.js';
import { handOverNow } from './immediate-delivery.js';
import { userName, UserName } from '../user-profile.js';

const logger = createLogger('CoordinatorFastReply');

export const DEFAULT_FAST_REPLY_MODEL = 'claude-sonnet-5';
export const FAST_REPLY_THREAD_TURNS = 6;
/**
 * Room for the longest answer the responder is asked for — a recap of a whole
 * project, in grouped bullets. Bullets, group labels and blank lines cost more
 * tokens than the same facts as prose, and at 1024 a replay of the 2026-09-20
 * recap was cut off mid-sentence. A quick answer that stops halfway is worse
 * than a slow one.
 */
const MAX_OUTPUT_TOKENS = 2048;
/**
 * Thinking is off. Left to itself Sonnet 5 sometimes starts an adaptive
 * thinking block, which counts against the output cap: in a 2026-09-24 replay
 * one call spent all 2048 tokens thinking and returned no text, and those
 * calls took 19-23s against 1-7s without it. It does not accept a thinking
 * budget of its own (`enabled` with `budget_tokens` is rejected), so off is
 * the only way to keep the cap for the answer.
 */
const THINKING = { type: 'disabled' } as const;
/**
 * What the responder says instead of an answer it cannot ground. The row is
 * then released unanswered — the same path a failed call takes — so no box
 * appears and the message reaches the coordinator whole at its turn end
 * (a quick answer may abstain; a useful partial one states its specific
 * limit).
 */
export const NO_USEFUL_ANSWER = 'NO USEFUL ANSWER';

export function fastReplyModel(): string {
  try {
    return ConfigService.getInstance().getConfig().coordinator?.fastReply?.model?.trim() || DEFAULT_FAST_REPLY_MODEL;
  } catch {
    return DEFAULT_FAST_REPLY_MODEL;
  }
}

export interface FastReplyContext {
  conversationId: string;
  workingDirectory: string;
  projectState: string;
  roster: string;
  thread: string;
  activity: string;
  message: string;
}

/** The whole prompt, exported so tests can see what the responder is told. */
export function buildFastReplyPrompt(context: FastReplyContext): { system: string; user: string } {
  const system = [
    `You are \`front\`, the conversation ${userName()} talks to about the work, answering for it while it is mid-way through a`,
    'turn. You have no tools. What you have is the project state front noted, its worker roster, the recent thread',
    'and the list of tool calls front has made this turn, all from the server\'s records. You cannot see what those',
    'calls returned, the files it is reading, the app as it currently renders, or what it has found and not yet said.',
    '',
    `You are writing to ${userName()} and to nobody else. Address them as "you"; never refer to them in the third person and`,
    'never write as though some other reader were listening in. They are the one asking, and the question is theirs.',
    '',
    'What happens to the quick answer you write, so you can say it accurately if they ask. It appears in their thread',
    `straight away, in a box labelled as an automatic quick answer, separate from front's own messages: it is not something`,
    `${userName()} said and it is not front speaking. When front's turn ends, the server hands front the message the quick`,
    'answer replied to and the quick answer itself, together in one batch, and records that it did. So front does receive',
    'the quick answer, at the end of its turn and not during it. That handover is the whole of what is established. Nothing records what',
    'front then does with it, so say it was handed over and stop there: never say front will read it, act on it, take',
    'it into account or follow it.',
    '',
    `Answer the message from what you have: the answer first, no preamble. ${UserName()} sees only their own messages and`,
    'front\'s text, so say things in your own words rather than pointing at a worker or a file. Do not say front',
    'will confirm, check or follow up on your answer.',
    'You are writing into a small box above front\'s own reply, so write plain sentences and paragraphs. No bold',
    'headings, no emoji, no status markers, no sections. A short answer is the good outcome; two or three',
    'paragraphs is the most the box should ever hold.',
    'Do not promise actions, dispatch anything, or make decisions: you answer, front acts. No time estimates.',
    '',
    'Answer the question they actually asked, about the thing they asked about. When they ask about a heading, a screen,',
    'a number or a word they are looking at, that is the subject; who is doing the work, which thread it sits under and',
    'which worker owns it are not answers to it. Nearly everything you have been given is written in those terms —',
    'threads with owners, workers with tasks — because that is how the record is kept, not because it is what they',
    'want back. Never answer a question about the product with the logistics of building it. Work on other things',
    'is not an answer to what they raised, and reciting it is the thing they object to most.',
    '',
    `Not every message is a question. When ${userName()} is correcting the work, saying what they do or do not want, or`,
    'reporting something that looks wrong, answer that: take the point they made and tell them what you can about it',
    'from what you have. Do not answer a different question. Do not say it has been noted, logged, assigned or',
    'picked up — you cannot do any of that, and front has not done it yet.',
    '',
    'Say what you cannot see, specifically. Not "I do not have that" but which thing is missing and where it lives:',
    '"the record says the headings changed at 20:12 and that you have not reviewed them yet; what the sidebar',
    'renders right now is in front\'s working context, not mine". A limit put that way tells them whether to wait for',
    'front or ask something else. A vague one only costs them a read.',
    '',
    'You are also shown what front has run in this turn: one line per tool call, what it was pointed at, never what',
    'came back. It is there to tell you whether front is working out the very thing they asked, not to answer from.',
    'A command is not its result: never infer an answer from what front ran.',
    '',
    'Most messages can be answered from the record: what a worker found, what is waiting on them, which two things',
    'they are mixing up, a recap, a draft built from points already settled. Answer those. Abstaining is for the',
    'cases below, not for anything you are less than sure of.',
    '',
    `Reply with exactly ${NO_USEFUL_ANSWER} when any of these holds:`,
    '- The answer they asked for is what front is producing right now: its last words say it is finding, counting',
    '  or checking that very thing, or its calls are plainly aimed at it. Front being busy, even on something',
    '  nearby, is not this; your answer would have to be a guess at the result front is about to have.',
    '- They ask whether something is right, justified or real — a finding, a rejection, a claim — and all you have',
    '  is a summary of it. Restating the summary with a conclusion on top is not a verdict.',
    '- The answer is a number, a duration or a technical conclusion that the record does not state and you would',
    '  have to work out. Relaying what is written is your job; deriving what follows from it is front\'s.',
    '- The message asks nothing you can answer: a fragment finishing an earlier sentence, a pasted message or',
    '  error with no question beyond "what?", or feedback where the only thing you could add is its status.',
    '- Your answer would only say what you cannot see, with nothing from the record beside it. That box is empty.',
    '',
    `When you have nothing grounded to say — the answer is not in the state, the roster or the thread, and naming`,
    `what you cannot see would not help them either — reply with exactly ${NO_USEFUL_ANSWER} and nothing else. No box`,
    'is shown, and their message reaches front untouched when its turn ends. An empty quick answer costs them nothing;',
    'a filled one that misses costs them a read and can leave them believing something untrue, so abstain rather than',
    'reach. Never guess at how Lattice itself works, at what front has done this turn, or at what is on their screen.',
    'The paragraph above about what happens to your answer is not a guess: it is a fact you have been given. When they',
    'ask where their message goes, whether front sees this answer, or when front gets it, answer from that paragraph.',
    'Abstaining there would leave them with the confusion they wrote in about.',
    '',
    'The project state and roster are there to answer them, not to comment on. Do not offer a view on how many',
    'workers are running or how much is in flight unless they asked. They are a snapshot of this instant, and front',
    'is mid-turn and may be dispatching as you write, so a thread with no worker against it is not',
    'evidence that nobody is on it. If they did ask and you say what is running, say it as what the record shows',
    'right now, never as a finding about what is being neglected.',
    '',
    ...messageShapeGuidance(),
    'Your answer is one bounded box in their thread, so keep it to what they asked: a few bullets, not a report with',
    'sections. Pick the facts around their question and what they have to decide next, never an inventory of what the',
    'workers have been doing.',
    '',
    `You are conversation ${context.conversationId} · cwd ${context.workingDirectory}`,
  ].join('\n');
  const user = [
    'Project state, as the coordinator noted it:',
    context.projectState,
    '',
    context.roster,
    '',
    'Recent thread, oldest first:',
    context.thread,
    '',
    'What front has run in its current turn, oldest first (for deciding whether to abstain, not for answering from):',
    context.activity,
    '',
    `The message from ${userName()} to answer now:`,
    context.message,
  ].join('\n');
  return { system, user };
}

/**
 * Answer one routed message. Never rejects: on any failure the row is
 * released to the next drain unanswered and the thread shows the message as
 * queued, which is what would have happened without the router.
 *
 * `attachToRow` is false when the message did not wait for this answer — it
 * was delivered into the running turn as it arrived.
 * Storing the answer on that row would put it somewhere nothing will look
 * again, so instead it becomes a row of its own and is handed over
 * separately. That row is what gives the answer a delivery status of its
 * own: the original was delivered when it arrived, and whether the answer
 * has reached the session is a different question with a different answer.
 */
export async function answerProvisionally(input: {
  conversationId: string;
  inboxId: string;
  message: string;
  attachToRow?: boolean;
}): Promise<void> {
  const { conversationId, inboxId, message } = input;
  const attachToRow = input.attachToRow !== false;
  let reply: string | null = null;
  try {
    reply = await generateReply(conversationId, message);
  } catch (err) {
    logger.warn('Fast reply failed; message waits for the turn', {
      conversationId,
      inboxId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (attachToRow) setInboxReply(inboxId, reply);
  if (reply) {
    const manager = getHarnessSessionManager();
    if (manager) {
      appendCustomHarnessEvent(manager, conversationId, COORDINATOR_REPLIED_EVENT, {
        inboxId,
        text: reply,
        model: fastReplyModel(),
        responder: 'fast',
      } satisfies CoordinatorRepliedData);
    }
  }
  if (attachToRow) {
    // The row is drainable again; if the turn ended meanwhile, this is the drain.
    void drainInbox(conversationId);
    return;
  }
  // An abstention is not handed over: there is nothing for the session to
  // know, and a row saying so would be noise in its next turn.
  if (!reply) return;
  const answerId = enqueueInboxItem({
    sessionId: conversationId,
    source: 'quick-answer',
    text: reply,
    answersId: inboxId,
  });
  await handOverNow(conversationId, answerId);
}

/** The reply, or null when the responder abstained (see `NO_USEFUL_ANSWER`). */
async function generateReply(conversationId: string, message: string): Promise<string | null> {
  const conversation = ConversationService.getInstance().getConversation(conversationId);
  if (!conversation?.coordinator) throw new Error('Not a coordinator conversation');
  const client = anthropicClientFactory.getClient();
  if (!client) throw new Error('Anthropic client unavailable (no API key configured)');

  const events = getEvents(conversationId);
  const prompt = buildFastReplyPrompt({
    conversationId,
    workingDirectory: conversation.workingDirectory,
    projectState: renderProjectState(foldProjectState(events), { userName: userName() }),
    roster: renderWorkerRoster(events, latticeCli()),
    thread: renderRecentThread(events, FAST_REPLY_THREAD_TURNS),
    activity: renderCurrentTurnActivity(events),
    message,
  });
  const model = fastReplyModel();
  const started = Date.now();
  const response = await client.messages.create({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    thinking: THINKING,
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
  });
  const durationMs = Date.now() - started;
  try {
    getCostTracker().log({
      sessionId: conversationId,
      operation: 'COORDINATOR_FAST_REPLY',
      model,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      cacheCreationInputTokens: response.usage?.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: response.usage?.cache_read_input_tokens ?? 0,
      durationMs,
    });
  } catch (err) {
    logger.debug('Cost tracking failed', { error: err });
  }
  const text = response.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!text) throw new Error('Fast responder returned no text');
  // Abstention. Matched on the opening rather than the whole text: a model
  // that adds a sentence of explanation after the sentinel has still said it
  // has nothing, and showing that sentence would be the empty box again.
  if (text.toUpperCase().startsWith(NO_USEFUL_ANSWER)) {
    logger.info('Fast responder abstained; the message goes to the coordinator unanswered', { conversationId, model, ms: durationMs });
    return null;
  }
  if (response.stop_reason === 'max_tokens') {
    logger.warn('Fast reply hit the output cap and is cut off', { conversationId, model, chars: text.length });
  }
  logger.info('Fast reply written', { conversationId, model, ms: durationMs, chars: text.length });
  return text;
}
