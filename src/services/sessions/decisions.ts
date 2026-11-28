/**
 * `lattice ask`: an agent's question to the user, as a card in its own thread,
 * and the user's answer, delivered back to it.
 *
 * The card is a `decision:asked` event in the thread's log; the agent ends its
 * turn as usual. The answer is a `decision:answered` event, which the thread
 * shows as the user's message, and an inbox row (`source: 'decision'`) handed
 * over at once, as a reaction is (`message-reactions.ts`). See
 * `types/decisions.ts` for the events and the fold.
 */

import { randomUUID } from 'node:crypto';
import { getHarnessSessionManager } from '../../harness/setup.js';
import { appendCustomHarnessEvent } from '../../harness/harness-custom-events.js';
import { getEvents } from '../../session-history/repository.js';
import {
  INBOX_REQUEST_KINDS,
  type InboxArtifact,
  type InboxMetric,
  type InboxRequestKind,
} from '../../types/inbox-feed.js';
import {
  DECISION_ACTION_RAN_EVENT,
  DECISION_ANSWERED_EVENT,
  DECISION_ASKED_EVENT,
  DECISION_MAX_OPTIONS,
  DECISION_MIN_OPTIONS,
  DECISION_DISMISSED_EVENT,
  DECISION_SETTLED_EVENT,
  DECISION_WITHDRAWN_EVENT,
  DECISION_JUDGED_EVENT,
  isAwaitingDecision,
  isOpenDecision,
  type DecisionActionData,
  type DecisionAnsweredData,
  type DecisionAskedData,
  type DecisionJudgedData,
  type DecisionOptionData,
  type DecisionWithdrawnData,
} from '../../types/decisions.js';
import { ConversationService } from './conversation-service.js';
import { readWorkerStates } from './worker-events.js';
import { enqueueInboxItem, withdrawInboxItem } from './session-inbox.js';
import { handOverNow } from './immediate-delivery.js';
import { UserName } from '../user-profile.js';
import { noteUserSent } from './project-needs-you.js';
import { noteStatusChanged } from './session-status-changes.js';
import { decisionsIn, openDecision } from './open-decision.js';
import { readProjectState } from './project-state.js';
import { pluginConfirmHandler } from '../plugins/plugin-registry.js';
import type { SessionManager } from '@liggi/agent-ui-harness/server';
import { anthropicClientFactory } from '../infrastructure/anthropic-client-factory.js';
import { createLogger } from '../infrastructure/logger.js';
import { bounceMessage, judgeCard, type JudgeCard, type JudgeVerdict } from './ask-judge.js';

export class DecisionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function isWorker(conversationId: string): boolean {
  const coordinator = ConversationService.getInstance().getConversation(conversationId)?.pickedUpFrom;
  return Boolean(coordinator && readWorkerStates(coordinator).some((worker) => worker.worker === conversationId));
}

export const WORKER_ASK_REFUSAL = 'Workers do not ask the user directly: nobody reads a worker\'s thread for questions. End your turn with "Question for front:" and your coordinator will decide or ask the user.';

/** Refuses what the card cannot show well: the reason is written for the agent that asked. */
function checkQuestion(question: string, options: DecisionOptionData[]): void {
  if (!question.trim()) throw new DecisionError('The question is empty.', 400);
  if (options.length < DECISION_MIN_OPTIONS || options.length > DECISION_MAX_OPTIONS) {
    throw new DecisionError(`A decision has ${DECISION_MIN_OPTIONS} to ${DECISION_MAX_OPTIONS} options; this has ${options.length}. The user can always answer in their own words, so there is no need for an "other" option.`, 400);
  }
  const labels = new Set<string>();
  for (const option of options) {
    if (!option.label.trim()) throw new DecisionError('An option has no label.', 400);
    if (!option.consequence.trim()) throw new DecisionError(`Option "${option.label}" has no consequence. Say in one line what choosing it sets in motion (--because).`, 400);
    if (labels.has(option.label)) throw new DecisionError(`Two options are both "${option.label}".`, 400);
    labels.add(option.label);
  }
  if (options.filter((option) => option.recommended).length > 1) throw new DecisionError('Recommend one option at most.', 400);
}

export interface DecisionAskMeta {
  requestKind?: InboxRequestKind;
  priorityReason?: string;
  context?: string[];
  metrics?: InboxMetric[];
  artifact?: InboxArtifact;
  ifUnanswered?: string;
}

const VALID_REQUEST_KINDS = new Set<string>(INBOX_REQUEST_KINDS);

function normalizeMeta(meta?: DecisionAskMeta): Partial<DecisionAskedData> {
  if (!meta) return {};
  const out: Partial<DecisionAskedData> = {};
  if (meta.requestKind !== undefined) {
    if (!VALID_REQUEST_KINDS.has(meta.requestKind)) {
      throw new DecisionError(`--kind must be one of ${INBOX_REQUEST_KINDS.join(', ')}.`, 400);
    }
    out.requestKind = meta.requestKind;
  }
  const priorityReason = meta.priorityReason?.trim();
  if (priorityReason) out.priorityReason = priorityReason;
  const ifUnanswered = meta.ifUnanswered?.trim();
  if (ifUnanswered) out.ifUnanswered = ifUnanswered;
  if (meta.context && meta.context.length > 0) {
    const bullets = meta.context.map((line) => line.trim()).filter(Boolean).slice(0, 6);
    if (bullets.length > 0) out.context = bullets;
  }
  if (meta.metrics && meta.metrics.length > 0) {
    const rows = meta.metrics
      .map((row) => ({
        label: row.label.trim(),
        value: row.value.trim(),
        ...(row.tone === 'worse' || row.tone === 'better' || row.tone === 'neutral' ? { tone: row.tone } : {}),
      }))
      .filter((row) => row.label && row.value)
      .slice(0, 8);
    if (rows.length > 0) out.metrics = rows;
  }
  if (meta.artifact) {
    const label = meta.artifact.label?.trim();
    if (!label) throw new DecisionError('An artifact needs a label.', 400);
    const kind = meta.artifact.kind;
    if (kind !== 'message' && kind !== 'text' && kind !== 'image' && kind !== 'table') {
      throw new DecisionError('Artifact kind must be message, text, image, or table.', 400);
    }
    const images = meta.artifact.images
      ?.map((img) => ({ src: img.src.trim(), ...(img.caption?.trim() ? { caption: img.caption.trim() } : {}) }))
      .filter((img) => img.src)
      .slice(0, 4);
    out.artifact = {
      kind,
      label,
      ...(meta.artifact.meta?.trim() ? { meta: meta.artifact.meta.trim() } : {}),
      ...(meta.artifact.body !== undefined ? { body: meta.artifact.body } : {}),
      ...(meta.artifact.editable ? { editable: true } : {}),
      ...(images && images.length > 0 ? { images } : {}),
      ...(meta.artifact.table ? { table: meta.artifact.table } : {}),
    };
  }
  return out;
}

const RAW_CONVERSATION_ID_RE = /\bconv-[A-Za-z0-9_-]{6,}\b/;
const RAW_HEX_HASH_RE = /(?<![A-Za-z0-9_/#-])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}\b/i;
const RAW_LOCAL_PATH_RE = /(?:^|[\s(`'"])((?:~|\/(?:Users|tmp|var|home|opt))\/[^\s`'")]+)/;
const RAW_SLACK_CHANNEL_RE = /(?<![\w#])#?C(?=[0-9A-Z]*[0-9])[0-9A-Z]{8,10}\b/;
// Pointers to text the user has to go and find. "In chat" alone also describes where future
// work will land ("a doc here in chat"), so it counts only in the question and context.
const PAST_CHAT_POINTER_SOURCE = String.raw`above\s+in\s+(?:the\s+)?chat|see\s+(?:above|chat|below)|(?:screenshots?|draft|text|wording)\s+(?:is|are)\s+(?:already\s+)?in\s+(?:the\s+)?chat|(?:posted|shown|listed|described|quoted)\s+above|in\s+my\s+(?:last\s+|earlier\s+|previous\s+)?(?:message|report|reply)`;
const PAST_CHAT_POINTER_RE = new RegExp(String.raw`\b(?:${PAST_CHAT_POINTER_SOURCE})\b`, 'i');
const CHAT_POINTER_RE = new RegExp(String.raw`\b(?:${PAST_CHAT_POINTER_SOURCE}|in\s+(?:the\s+)?chat|screenshots?\s+in\s+(?:the\s+)?chat|(?:draft|text)\s+in\s+(?:the\s+)?chat)\b`, 'i');
const VISUAL_POINTER_RE = /\b(?:screenshots?|images?|mock(?:-?ups?)?|mockups?|pictures?|visuals?|figures?|diagrams?|layouts?)\b/i;
const DRAFT_PERMISSION_SLIP_RE = /\b(?:draft|drafts|write|writes)\s+(?:a\s+|the\s+)?(?:short\s+|quick\s+)?(?:dm|direct\s+message|message|reply|replies|email|slack|note)\b[^.?!]{0,40}\bfor\s+(?:your\s+)?(?:ok|review|approval)\b|\bshould\s+(?:i|we)\s+draft\s+(?:a\s+|the\s+)?(?:short\s+|quick\s+)?(?:dm|message|reply|email|slack)\b|\bI(?:'ll)?\s+(?:draft|write)\s+(?:a\s+|the\s+)?(?:short\s+|quick\s+)?(?:dm|message|note|reply|email)\b|^draft\s+(?:a\s+|the\s+)?(?:short\s+|quick\s+)?(?:dm|message|note|reply|email)\s+to\b/i;
const SEND_MESSAGE_ASK_RE = /\b(?:send|post|reply\s+with|email)\s+(?:this|the|my|our|[A-Z][a-z]+'s)?\s*(?:short\s+|quick\s+|updated\s+|final\s+|two\s+|three\s+)?(?:dm|direct\s+message|message|reply|replies|draft|email|slack(?:\s+(?:dm|message|post|reply))?|note|announcement)\b|(?<!\b(?:the|a|an|this|that|my|our|your|their|its)\s+(?:[\w'-]+\s+)?)\b(?:send|post)\b[^?]{0,30}\b(?:dm|slack|reply|replies|email)\b|^reply\s+to\b/i;
// "Tell Sam that …": case-sensitive, so the name must be capitalised.
const TELL_SOMEONE_RE = /^Tell\s+[A-Z][\w'-]+(?:\s+and\s+[A-Z][\w'-]+)?\s+(?:that|about|to)\b/;
// A `?` that opens a URL query (`?ashindex`, `?a=1`) is not a question.
const QUESTION_MARK_RE = /\?(?![\w=&])/g;
// A quoted title with a `?` in it ('Ready to train?'), or a capitalised one after an article
// followed by a lowercase noun ("the Did it work? mock").
const QUOTED_QUESTION_RE = /(?<![\w])['"‘“][^'"’”]*\?[^'"’”]*['"’”](?![\w])/g;
const TITLE_QUESTION_RE = /\b(?:the|a|an|this|our|its)\s+[A-Z][^?]*\?(?=\s+[a-z])/g;
const BUNDLED_CLAUSE_RE = /,\s+and\s+(?:how|what|which|when|where|who|shall|should)\b/i;
const VISUAL_CHOICE_RE = /\b(?:(?<!-)layouts?|ui\s+(?:layout|design|option|variant|change|polish|restyle|direction)|looks?\s+better|which\s+(?:mock|screen|card|chart|figure|diagram|theme|palette|style)|which\s+(?:[\w'-]+\s+){0,2}(?:look|icons?)|as\s+(?:mocked(?:\s+up)?|shown)|mock\s+(?:agreed|approved|ok(?:ay)?)|from\s+(?:the\s+)?(?:[\w-]+\s+)?screenshots|in\s+the\s+mock(?:-?up|up)?|(?:the\s+)?mock(?:-?up|up)?\s+shows|revised\s+(?:[\w-]+\s+){0,3}mock(?:-?up|up)?|review\s+(?:the\s+)?(?:mock|screenshot|screenshots|visual|ui|figure|diagram|chart))\b/i;
const DEFER_OPTION_RE = /^(?:hold|not\s+now|wait|cancel|skip|neither|none|keep\s+as\s+is|leave\s+as\s+is|more\s+comments|tweak|pass|later|dismiss|no\b)/i;

function findRawIdentifier(texts: string[]): string | null {
  for (const text of texts) {
    const conv = RAW_CONVERSATION_ID_RE.exec(text);
    if (conv) return conv[0];
    const hash = RAW_HEX_HASH_RE.exec(text);
    if (hash) return hash[0];
    const file = RAW_LOCAL_PATH_RE.exec(text);
    if (file) return file[1];
    const channel = RAW_SLACK_CHANNEL_RE.exec(text);
    if (channel) return channel[0];
  }
  return null;
}

/** Whether the card's attachment carries what a chat pointer refers to: an image for a visual, text otherwise. */
function attachmentCovers(pointerLine: string, artifact?: InboxArtifact): boolean {
  if (!artifact) return false;
  if (VISUAL_POINTER_RE.test(pointerLine)) return artifact.kind === 'image' && (artifact.images?.length ?? 0) > 0;
  if (artifact.kind === 'message' || artifact.kind === 'text') return Boolean(artifact.body?.trim());
  return artifact.kind === 'table' && (artifact.table?.rows.length ?? 0) > 0;
}

function countQuestions(question: string): number {
  const titlesRemoved = question.replace(QUOTED_QUESTION_RE, 'title').replace(TITLE_QUESTION_RE, (m) => m.slice(0, -1));
  return (titlesRemoved.match(QUESTION_MARK_RE) ?? []).length;
}

/**
 * Enforces the cold-read Inbox quality bar on agent `lattice ask` cards so the
 * user never has to leave Inbox to understand or decide. Pure; exported for tests.
 */
export function checkColdReadQuality(
  question: string,
  options: DecisionOptionData[],
  meta?: Partial<DecisionAskedData>,
): void {
  if (!meta?.requestKind) {
    throw new DecisionError(
      `Missing --kind. Classify what you are asking for (--kind ${INBOX_REQUEST_KINDS.join('|')}) so the Inbox shows why the user is being asked.`,
      400,
    );
  }

  const contextLines = (meta.context ?? []).map((line) => line.trim()).filter(Boolean);
  if (contextLines.length === 0 || contextLines.join(' ').length < 15) {
    throw new DecisionError(
      'Missing orientation (--context). The user reads this cold in Inbox without opening chat. Pass 1-3 short --context bullets in plain English explaining what this is about and why you need their call.',
      400,
    );
  }

  if (countQuestions(question) > 1 || BUNDLED_CLAUSE_RE.test(question)) {
    throw new DecisionError(
      'Ask one decision per card. Split unrelated questions into separate asks so each card has clear, independent options.',
      400,
    );
  }

  const userFacingTexts = [
    question,
    ...contextLines,
    ...options.flatMap((o) => [o.label, o.consequence]),
    ...(meta.priorityReason ? [meta.priorityReason] : []),
    ...(meta.ifUnanswered ? [meta.ifUnanswered] : []),
  ];
  const rawId = findRawIdentifier(userFacingTexts);
  if (rawId) {
    throw new DecisionError(
      `Remove raw IDs, hashes, or file paths ("${rawId}") from the card. Use plain names the user recognises cold from Inbox without opening chat.`,
      400,
    );
  }

  const pointerChecks: [string, RegExp][] = [
    ...[question, ...contextLines].map((text): [string, RegExp] => [text, CHAT_POINTER_RE]),
    ...options.map((o): [string, RegExp] => [o.consequence, PAST_CHAT_POINTER_RE]),
  ];
  for (const [text, re] of pointerChecks) {
    const pointer = re.exec(text);
    if (pointer && !attachmentCovers(text, meta.artifact)) {
      throw new DecisionError(
        `Do not point the user back to chat ("${pointer[0]}"). They should never have to leave Inbox to decide: attach text inline with --draft/--draft-file or visuals with --image, or put the key facts directly in --context.`,
        400,
      );
    }
  }

  const hasDraft = Boolean(
    meta.artifact
    && (meta.artifact.kind === 'message' || meta.artifact.kind === 'text')
    && meta.artifact.body?.trim(),
  );
  if (!hasDraft) {
    for (const text of [question, ...options.flatMap((o) => [o.label, o.consequence])]) {
      const slip = DRAFT_PERMISSION_SLIP_RE.exec(text);
      if (slip) {
        throw new DecisionError(
          `Do not ask permission to draft a message ("${slip[0]}"). Draft it first without sending, then ask once with --draft inline so the user can approve or edit in one tap.`,
          400,
        );
      }
    }
  }

  const primaryOption = options.find((o) => o.recommended) ?? options[0];
  const asksToSend = (text: string) => SEND_MESSAGE_ASK_RE.test(text) || TELL_SOMEONE_RE.test(text);
  if (!hasDraft && (asksToSend(question) || (primaryOption && asksToSend(primaryOption.label)))) {
    throw new DecisionError(
      'This asks to send or approve a message, but no draft is attached. Pass the full text inline with --draft (or --draft-file) and --draft-meta "<recipient>" (add --editable if they might tweak it) so they can approve or edit right in Inbox.',
      400,
    );
  }

  const images = meta.artifact?.kind === 'image' ? (meta.artifact.images ?? []) : [];
  if (images.length >= 2 && images.some((img) => !img.caption?.trim())) {
    throw new DecisionError(
      'When attaching multiple images, give each one a caption (--image "<path>::<option label>") so the user can tell which visual matches which option.',
      400,
    );
  }
  if (VISUAL_CHOICE_RE.test(question)) {
    if (images.length === 0) {
      throw new DecisionError(
        'This asks for a visual or UI judgment, but no image is attached. Attach screenshots inline with --image "<abs-path>::<caption>" so the user can judge without leaving Inbox.',
        400,
      );
    }
    const visualOptions = options.filter((o) => !DEFER_OPTION_RE.test(o.label.trim())).length;
    const needed = Math.min(visualOptions, 4);
    if (needed >= 2 && images.length < needed) {
      throw new DecisionError(
        `This compares ${visualOptions} visual options, but only ${images.length} image(s) are attached. Pass one captioned --image "<abs-path>::<caption>" for each choice (${needed} total) so the user can compare them in Inbox.`,
        400,
      );
    }
  }
}

const logger = createLogger('Decisions');

export interface AskJudgeDeps {
  judge: (card: JudgeCard) => Promise<JudgeVerdict>;
  record: (data: DecisionJudgedData) => void;
  now?: () => number;
}

/** After a bounce, the session's next ask within this long is put up whatever the judge says. */
const RETRY_WINDOW_MS = 60 * 60 * 1000;
const JUDGE_TIMEOUT_MS = 45_000;
const bouncedAt = new Map<string, number>();

/** Judges an agent's card, refusing it once with the judge's reasons; logs every verdict. */
export async function screenAgentAsk(threadId: string, card: JudgeCard, deps: AskJudgeDeps): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  const bounced = bouncedAt.get(threadId);
  const secondTry = bounced !== undefined && now - bounced < RETRY_WINDOW_MS;
  bouncedAt.delete(threadId);
  let verdict: JudgeVerdict;
  try {
    verdict = await deps.judge(card);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn('The cold-read judge failed, so the ask goes up unjudged', { threadId, error });
    deps.record({ question: card.question, outcome: 'judge-error', secondTry, error });
    return;
  }
  const outcome = verdict.pass ? 'passed' : secondTry ? 'let-through' : 'bounced';
  deps.record({
    question: card.question,
    outcome,
    secondTry,
    pass: verdict.pass,
    knowledgeLevel: verdict.knowledgeNeeded.level,
    failed: Object.entries(verdict.items).filter(([id, answer]) => id !== 'A1' && answer === 'no').map(([id]) => id),
    model: verdict.model,
    effort: verdict.effort,
    costUsd: verdict.costUsd,
    ms: verdict.ms,
    imagesSent: verdict.imagesSent,
  });
  if (outcome !== 'bounced') return;
  bouncedAt.set(threadId, now);
  throw new DecisionError(bounceMessage(verdict), 422);
}

function liveAskJudge(threadId: string): AskJudgeDeps {
  return {
    judge: (card) => {
      const client = anthropicClientFactory.getClient();
      if (!client) return Promise.reject(new Error('No Anthropic API key is configured'));
      return judgeCard(client, card, { signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS) });
    },
    record: (data) => {
      const manager = getHarnessSessionManager();
      if (manager) appendCustomHarnessEvent(manager, threadId, DECISION_JUDGED_EVENT, data);
    },
  };
}

/**
 * Puts the card in the agent's thread. A question still unanswered there is
 * replaced by it. A plugin's card also carries `detail`, shown verbatim, and
 * the `action` its `runs` option sets off.
 */
export function askDecision(
  threadId: string,
  question: string,
  options: DecisionOptionData[],
  projectThread?: number,
  plugin?: { detail?: string; view?: string; action: DecisionActionData },
  meta?: DecisionAskMeta,
): { id: string; replaced: string | null } {
  const normalizedMeta = validateAsk(threadId, question, options, projectThread, plugin, meta);
  return writeAsk(threadId, question, options, projectThread, plugin, normalizedMeta);
}

/**
 * An agent's `lattice ask`: checked like any card, then read by the cold-read
 * judge, which refuses a card the user could not decide from the Inbox alone.
 * A refusal is given once: the session's next ask is put up whatever the judge
 * says, and a judge that cannot be reached lets the ask through.
 */
export async function askAgentDecision(
  threadId: string,
  question: string,
  options: DecisionOptionData[],
  projectThread?: number,
  meta?: DecisionAskMeta,
  judge: AskJudgeDeps = liveAskJudge(threadId),
): Promise<{ id: string; replaced: string | null }> {
  const normalizedMeta = validateAsk(threadId, question, options, projectThread, undefined, meta);
  await screenAgentAsk(threadId, { question, options, meta: normalizedMeta }, judge);
  return writeAsk(threadId, question, options, projectThread, undefined, normalizedMeta);
}

function validateAsk(
  threadId: string,
  question: string,
  options: DecisionOptionData[],
  projectThread: number | undefined,
  plugin: { detail?: string; view?: string; action: DecisionActionData } | undefined,
  meta: DecisionAskMeta | undefined,
): Partial<DecisionAskedData> {
  if (!ConversationService.getInstance().getConversation(threadId)) throw new DecisionError(`No conversation ${threadId}`, 404);
  if (isWorker(threadId)) throw new DecisionError(WORKER_ASK_REFUSAL, 409);
  checkQuestion(question, options);
  const normalizedMeta = normalizeMeta(meta);
  if (!plugin) checkColdReadQuality(question, options, normalizedMeta);
  if (plugin && !options.some((option) => option.label.trim() === plugin.action.runs)) {
    throw new DecisionError(`No option is labelled "${plugin.action.runs}", the one that runs the action.`, 400);
  }
  if (projectThread !== undefined && !readProjectState(threadId).open.some((thread) => thread.seq === projectThread && !thread.parked)) {
    throw new DecisionError(`--thread names one of this project's open threads; ${projectThread} is not one.`, 400);
  }
  return normalizedMeta;
}

function writeAsk(
  threadId: string,
  question: string,
  options: DecisionOptionData[],
  projectThread: number | undefined,
  plugin: { detail?: string; view?: string; action: DecisionActionData } | undefined,
  normalizedMeta: Partial<DecisionAskedData>,
): { id: string; replaced: string | null } {
  const manager = getHarnessSessionManager();
  if (!manager) throw new Error('No harness session manager');
  const open = [...decisionsIn(threadId).values()].find(isOpenDecision);
  const data: DecisionAskedData = {
    id: randomUUID(),
    question: question.trim(),
    options: options.map((option) => ({
      label: option.label.trim(),
      consequence: option.consequence.trim(),
      ...(option.recommended ? { recommended: true } : {}),
    })),
    ...(projectThread !== undefined ? { thread: projectThread } : {}),
    ...(plugin && manager.getStatus(threadId) === 'idle' ? { shownAtOnce: true } : {}),
    ...(plugin?.detail ? { detail: plugin.detail } : {}),
    ...(plugin?.view ? { view: plugin.view } : {}),
    ...(plugin ? { action: plugin.action } : {}),
    ...normalizedMeta,
  };
  if (!appendCustomHarnessEvent(manager, threadId, DECISION_ASKED_EVENT, data)) {
    throw new Error(`The question could not be written to ${threadId}`);
  }
  return { id: data.id, replaced: open?.asked.id ?? null };
}

/**
 * A question Codex asked with `request_user_input_async`, which cannot be
 * refused with an error: the tool has already returned and Codex keeps its
 * turn open waiting for the reply. So it is not checked like `lattice ask`,
 * and a worker, which gets no card, is told why in its running turn instead.
 */
export async function recordCodexQuestion(threadId: string, data: DecisionAskedData): Promise<void> {
  const manager = getHarnessSessionManager();
  if (!manager) throw new Error('No harness session manager');
  if (!isWorker(threadId)) {
    appendCustomHarnessEvent(manager, threadId, DECISION_ASKED_EVENT, data);
    return;
  }
  const inboxId = enqueueInboxItem({ sessionId: threadId, source: 'decision', text: `Your question "${data.question}" was not shown to anyone. ${WORKER_ASK_REFUSAL}` });
  await handOverNow(threadId, inboxId);
}

/** The line the agent reads. */
function answerLine(question: string, answer: string, ownWords: boolean, correction: boolean): string {
  if (correction) return `${UserName()} changed their answer to your question "${question}". It is now: ${answer}`;
  return ownWords
    ? `${UserName()} answered your question "${question}" in their own words: ${answer}`
    : `${UserName()} answered your question "${question}": ${answer}`;
}

/**
 * Records the user's answer and hands it to the agent. Answering again is a
 * change of mind: an answer the agent has not read yet is taken back and
 * replaced; one it has read is followed by a correction. `edit` is text the
 * user changed in a plugin card's view, handed to its action.
 */
export async function answerDecision(threadId: string, decisionId: string, rawAnswer: string, edit?: string): Promise<{ delivered: 'answer' | 'replacement' | 'correction' }> {
  const manager = getHarnessSessionManager();
  if (!manager) throw new Error('No harness session manager');
  const answer = rawAnswer.trim();
  if (!answer) throw new DecisionError('The answer is empty.', 400);
  const decision = decisionsIn(threadId).get(decisionId);
  if (!decision) throw new DecisionError('That question is not in this thread.', 404);
  if (decision.replaced) throw new DecisionError('A later question replaced this one.', 409);
  if (decision.settled) throw new DecisionError('This question was answered in the chat.', 409);
  if (decision.answer !== null && !decision.latest) throw new DecisionError('Only the latest question can have its answer changed.', 409);
  const action = decision.asked.action;
  // Choosing the action again after it failed is a retry, not a repeat of the same answer.
  const retry = Boolean(action && answer === action.runs && !decision.actionRan);
  if (decision.answer === answer && !retry) return { delivered: 'answer' };
  if (action && actionsRunning.has(decisionId)) throw new DecisionError(`"${action.runs}" is already under way.`, 409);
  if (action && decision.actionRan) {
    throw new DecisionError(`"${action.runs}" has already been done and cannot be taken back.`, 409);
  }

  let correction = false;
  let replacement = false;
  if (decision.answer !== null) {
    const previous = getEvents(threadId, { types: [DECISION_ANSWERED_EVENT] })
      .map((event) => event.data as DecisionAnsweredData)
      .filter((data) => data.id === decisionId)
      .at(-1);
    replacement = Boolean(previous && withdrawInboxItem(previous.inboxId));
    correction = !replacement;
  }

  const ownWords = !decision.asked.options.some((option) => option.label === answer);
  const outcome = action && answer === action.runs ? await runAction(manager, threadId, decisionId, action, edit) : null;
  const line = answerLine(decision.asked.question, answer, ownWords, correction);
  const inboxId = enqueueInboxItem({ sessionId: threadId, source: 'decision', text: outcome ? `${line}\n${outcome}` : line });
  appendCustomHarnessEvent(manager, threadId, DECISION_ANSWERED_EVENT, { id: decisionId, answer, inboxId } satisfies DecisionAnsweredData);
  // An answer is the user replying, so it clears Needs you as a typed message does.
  noteUserSent(manager, threadId);
  await handOverNow(threadId, inboxId);
  return { delivered: correction ? 'correction' : replacement ? 'replacement' : 'answer' };
}

/** Cards whose action is running now: a second tap while the first is still sending must not send again. */
const actionsRunning = new Set<string>();

/**
 * Runs a plugin card's action, once: a success is recorded before the agent
 * hears of it, so a second tap or a restart cannot run it again. A failure is
 * not recorded, and the agent is told, so it can offer a new card.
 */
async function runAction(manager: SessionManager, threadId: string, decisionId: string, action: DecisionActionData, edit?: string): Promise<string> {
  const handler = pluginConfirmHandler(action.plugin, action.name);
  if (!handler) return `Nothing was done: the ${action.plugin} plugin is not loaded, or has no "${action.name}" action.`;
  actionsRunning.add(decisionId);
  try {
    const result = await handler(action.payload, { conversationId: threadId, cardId: decisionId, ...(edit !== undefined ? { edit } : {}) });
    appendCustomHarnessEvent(manager, threadId, DECISION_ACTION_RAN_EVENT, { id: decisionId });
    return result;
  } catch (error) {
    return `It failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    actionsRunning.delete(decisionId);
  }
}

/**
 * The user declines to answer an open question: the card closes as dismissed
 * and the agent is told so in one line. Unlike dismissing the project thread
 * it is about (`thread-dismissal.ts`), the thread stays open and its workers
 * carry on; only the question is gone.
 */
export async function dismissDecision(threadId: string, decisionId: string): Promise<void> {
  const manager = getHarnessSessionManager();
  if (!manager) throw new Error('No harness session manager');
  const decision = decisionsIn(threadId).get(decisionId);
  if (!decision) throw new DecisionError('That question is not in this thread.', 404);
  // A dismissal held in the panel (`held-replies.ts`) is the one that goes now.
  if (!isAwaitingDecision(decision)) throw new DecisionError('That question is no longer waiting on an answer.', 409);
  if (!appendCustomHarnessEvent(manager, threadId, DECISION_DISMISSED_EVENT, { id: decisionId })) {
    throw new Error(`The dismissal could not be written to ${threadId}`);
  }
  noteStatusChanged(threadId);
  const inboxId = enqueueInboxItem({ sessionId: threadId, source: 'decision', text: `${UserName()} dismissed your question "${decision.asked.question}" without answering.` });
  await handOverNow(threadId, inboxId);
}

/**
 * The agent that asked takes its own question down, because it was settled
 * some other way (`lattice ask --withdraw`). The card closes as withdrawn,
 * which is not the user dismissing it, so nothing goes back to the agent; the
 * project thread it was about stays open. Only the thread's own card can be
 * withdrawn, and only while it still waits on the user: once they have
 * answered, or an answer or dismissal is on its way from the panel, it is theirs.
 */
export function withdrawDecision(threadId: string, options: { thread?: number; reason?: string } = {}): { id: string; question: string } {
  const manager = getHarnessSessionManager();
  if (!manager) throw new Error('No harness session manager');
  if (!ConversationService.getInstance().getConversation(threadId)) throw new DecisionError(`No conversation ${threadId}`, 404);
  const latest = [...decisionsIn(threadId).values()].find((decision) => decision.latest);
  if (!latest || !isAwaitingDecision(latest)) throw new DecisionError('This thread has no open question to withdraw.', 404);
  if (options.thread !== undefined && latest.asked.thread !== options.thread) {
    throw new DecisionError(`The open question is not about thread ${options.thread}: "${latest.asked.question}".`, 409);
  }
  if (latest.held) throw new DecisionError(`${UserName()} has already answered "${latest.asked.question}" from the panel; their answer is on its way to you.`, 409);
  if (latest.asked.holdsTurn) throw new DecisionError('This question holds your turn open until it is answered, so it cannot be withdrawn.', 409);
  const reason = options.reason?.trim();
  const data: DecisionWithdrawnData = { id: latest.asked.id, ...(reason ? { reason } : {}) };
  if (!appendCustomHarnessEvent(manager, threadId, DECISION_WITHDRAWN_EVENT, data)) {
    throw new Error(`The withdrawal could not be written to ${threadId}`);
  }
  noteStatusChanged(threadId);
  return { id: latest.asked.id, question: latest.asked.question };
}

/**
 * The user wrote to the thread while its card was open: their message is the
 * answer, so the card closes as answered and no tap is expected. Called on a
 * composer send, before the message is written, so the card sits above it.
 * A card whose turn is still running has not been seen, so it stays open.
 */
export function settleOpenDecision(manager: SessionManager, threadId: string): void {
  const open = openDecision(threadId);
  if (open) appendCustomHarnessEvent(manager, threadId, DECISION_SETTLED_EVENT, { id: open.asked.id });
}
