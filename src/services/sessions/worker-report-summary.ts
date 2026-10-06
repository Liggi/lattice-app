/**
 * The readable summary at the top of a worker's report card.
 *
 * A report is written by one agent for another. It is long, it is in the
 * worker's own vocabulary, and the card showed the first few lines of it
 * clipped — so reading the thread meant expanding report after report to find
 * out what had happened. This writes the missing top: a result line, then two
 * to four short lines, one fact each — what changed, what is running, what was
 * checked, what remains — with the report itself still underneath, whole and
 * unaltered. Lines rather than a paragraph: parallel facts run together into
 * prose are exactly what made the report hard to read in the first place.
 *
 * Three rules shape the prompt, and they matter more than the brevity:
 *
 * 1. **The report is a claim, not a finding.** The worker is saying what it
 *    did; nobody has checked it. A summary that flattens "I believe the
 *    sidebar now renders" into "the sidebar renders" has turned the worker's
 *    account into the coordinator's, which is exactly the confusion the card
 *    exists to prevent.
 * 2. **What is running and what is not are different facts.** Not the same as
 *    "uncommitted means dead": an edit the dev server has picked up is live
 *    with nothing committed, while the server half of the same change waits on
 *    a restart. Reports say which is which, usually in a clause near the end,
 *    and it is the first thing a summariser flattens.
 * 3. **The bad news survives.** Blockers, open questions, things left
 *    undone, checks that failed or were never run — a summary that keeps only
 *    the accomplishments is worse than no summary, because it reads as
 *    completion.
 *
 * Bounds: gated by `generation.workerReportSummary`, closed by default; one
 * call per report, plus one follow-up when a line is over the card's bounds or
 * it names something the report does not, and never a retry loop; skipped when a summary for that
 * report already exists, so a replayed delivery cannot write a second one.
 *
 * It runs after the report has already reached the coordinator — the delivery
 * path does not wait on it — and it is never sent to the coordinator itself.
 * See `WORKER_REPORT_SUMMARY_EVENT` in `src/types/worker-events.ts`.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { backgroundTextClient, backgroundProvenance } from '../infrastructure/background-text-client.js';
import { ConfigService } from '../infrastructure/config-service.js';
import { allowGeneration } from '../infrastructure/generation-gates.js';
import { getCostTracker } from '../infrastructure/cost-tracker.js';
import { createLogger } from '../infrastructure/logger.js';
import { DEFAULT_MODELS } from '../insights/anthropic-service.js';
import { getHarnessSessionManager } from '../../harness/setup.js';
import { appendCustomHarnessEvent } from '../../harness/harness-custom-events.js';
import { getEvents } from '../../session-history/repository.js';
import { foldedWorkerStates } from './worker-events.js';
import {
  reportSummaryDraft,
  reportSummaryOverLimits,
  usableReportSummary,
  WORKER_REPORT_SUMMARY_EVENT,
  type WorkerReportSummaryData,
} from '../../types/worker-events.js';
import { userName } from '../user-profile.js';
import { unsupportedDetails } from '../insights/human-input.js';

const logger = createLogger('WorkerReportSummary');

const MAX_OUTPUT_TOKENS = 400;

/**
 * Pinned off, for the same measured reason as every insight call (see
 * `anthropic-service.ts`): on the 5-family an omitted `thinking` means
 * adaptive thinking is ON, and it spends a small `max_tokens` budget on
 * thinking and returns no text at all, with no error. This summary is 400
 * tokens of writing, so left adaptive it produced an empty answer and the
 * card silently fell back to the report on every single report — which reads
 * exactly like the feature not being switched on.
 */
const THINKING: Anthropic.ThinkingConfigParam = { type: 'disabled' };

/**
 * The generation tier, not the quick one. This is a faithfulness task under
 * three rules that a small model drops quietly — the failure is a confident,
 * well-formed summary that says the work is done — and it fires once per
 * report rather than on a timer, so the volume is bounded by how often
 * workers finish.
 */
export function summaryModel(): string {
  try {
    return ConfigService.getInstance().getConfig().anthropic?.models?.generation?.trim() || DEFAULT_MODELS.generation;
  } catch {
    return DEFAULT_MODELS.generation;
  }
}

/** The whole prompt, exported so tests can see what the writer is told. */
export function buildSummaryPrompt(task: string | null, report: string): { system: string; user: string } {
  const system = [
    `You write the summary at the top of a worker's report card, for ${userName()}. They are reading a thread of these to`,
    'follow what their agents have done. The full report sits underneath yours and they can open it; your job is to',
    'let them decide whether they need to.',
    '',
    'Answer in exactly this shape, and nothing else — no preamble, no closing line:',
    '',
    '  line 1  the result in three to eight words: one clause, sentence case, no full stop, no comma. Say the',
    '          outcome — "Header and sidebar simplified", "Sidebar layout rejected", "Blocked on the migration" —',
    '          never "Report on ..." or "Work on ...".',
    '  line 2  blank.',
    '  then    two to four lines, each beginning "- ". One fact per line, one sentence, under twenty-five words,',
    '          plain prose with no bold, no headings and no nested bullets. Separate lines, because these facts',
    '          are read at a glance and do not belong run together into a paragraph.',
    '',
    'This is the shape and the length:',
    '',
    '  Header and sidebar simplified',
    '',
    '  - The requested controls are gone, and on mobile the sidebar and menu buttons now sit together at the top right.',
    '  - Desktop and mobile interactions were checked in the running app.',
    '  - The interface changes are live now through the dev server.',
    '  - Fully removing the commitments backend still needs a restart.',
    '',
    'Four lines is the most a card can carry. A report holds far more than four facts, so choose: the outcome,',
    `what is actually running, and the one or two things most likely to change what ${userName()} does next. A line with`,
    'three clauses bolted together to smuggle in a fifth fact is worse than leaving it out. Everything you leave',
    'out is in the report underneath, unaltered — you are not responsible for carrying all of it, only for not',
    'misleading them about what you did carry.',
    '',
    'Faithfulness, which matters more than brevity:',
    '- Use only what the report says. Never add a fact, a cause, a next step or a conclusion it does not contain.',
    '- The report is the worker\'s own account. Nobody has checked it. Do not harden what the worker hedged: if it',
    '  says it believes, expects, or could not verify something, your line says so too.',
    '- Say what is running and what is not, and keep them apart, on their own lines when they differ. Uncommitted',
    '  code can be running: an edit the dev server has picked up is live even though nothing is committed. Other',
    '  work is not running until it is restarted, deployed, merged, released, or its flag is opened. Take which is',
    '  which from the report rather than deciding it yourself — if it says the interface is live and the server',
    '  half needs a restart, your summary says both. A passing test and a passing typecheck are neither.',
    '- Repeat check results as the report gives them. If tests failed, or a suite was not run, or a check was only',
    '  partly done, say so and say how many failed. Never round a partial result up to a clean one, and never say',
    '  tests pass when the report says some fail.',
    '- Keep every blocker, open question, uncertainty and remaining step that changes what happens next. If the',
    '  worker is stuck, is asking something, or disagrees with the approach, that is the first line.',
    '- The task above is context only: it says what the worker was sent to do, not what it did. State as done only',
    '  what the report itself says is done. A report that only says it is waiting on something is summarised as',
    '  waiting ("Waiting on CI for PR #290"), never as the task finished. Do not say what a PR, commit or branch',
    '  contains, or that the task\'s change was made, unless the report says so; the task is what was asked, not',
    '  what happened.',
    '- Copy every name, number, version, ticket, PR and commit id exactly as the report writes it. If you are not',
    '  sure of one, describe it in plain words instead of writing it from memory.',
    '- No praise, no verdict on the quality of the work, no "successfully", no counts of files or lines, no time',
    '  or effort estimates.',
    `- Name the part of the product ${userName()} would point at rather than the mechanism inside it. They have not read this`,
    '  code today and will not open the files.',
  ].join('\n');
  const user = [
    ...(task ? ['What this worker was sent to do (context only; the report says what was done):', task, ''] : []),
    'The report it ended its turn on, as written:',
    report,
  ].join('\n');
  return { system, user };
}

/**
 * Names, numbers and ids in a summary that its report and task do not contain,
 * checked a sentence at a time so each sentence's first word counts as a
 * sentence start rather than a name. Exported for tests.
 */
export function summaryDetailsMissing(summary: { title: string; text: string }, source: string): string[] {
  const sentences = [summary.title, ...summary.text.split('\n')]
    .flatMap((line) => line.replace(/^\s*-\s+/, '').split(/(?<=[.!?:;])\s+|\s+[\u2014-]\s+/))
    .filter((sentence) => sentence.trim());
  return [...new Set(sentences.flatMap((sentence) => unsupportedDetails(sentence, source)))];
}

/**
 * Whether this report already has a summary, and the task the coordinator
 * wrote for the worker at dispatch.
 *
 * Neither reads the whole log, because a coordinator's log is long — front's
 * was past 41,000 events on 2026-09-21: the summaries written since the report,
 * and the cached worker states.
 */
function summaryContext(
  coordinator: string,
  worker: string,
  reportSeq: number,
): { alreadySummarised: boolean; task: string | null } {
  try {
    const alreadySummarised = getEvents(coordinator, { fromSeq: reportSeq, types: [WORKER_REPORT_SUMMARY_EVENT] }).some(
      (event) => (event.data as { reportSeq?: number })?.reportSeq === reportSeq,
    );
    const task = foldedWorkerStates(coordinator).find((state) => state.worker === worker)?.task ?? null;
    return { alreadySummarised, task };
  } catch (err) {
    logger.debug('Could not read the coordinator log for context', {
      coordinator,
      error: err instanceof Error ? err.message : String(err),
    });
    return { alreadySummarised: false, task: null };
  }
}

export interface ReportToSummarise {
  coordinator: string;
  worker: string;
  /** The seq of the `worker:reported` event; the card joins the summary to the report by it. */
  reportSeq: number;
  report: string;
}

/**
 * Called from the delivery path once the report is already on its way to the
 * coordinator. Fire and forget: nothing waits on it, and a failure leaves the
 * card showing the report as stored. Never rejects.
 */
export function noteWorkerReport(request: ReportToSummarise): void {
  if (!allowGeneration('workerReportSummary')) return;
  void summariseReport(request).catch((err) => {
    logger.debug('Report summary failed; the card shows the report as stored', {
      worker: request.worker,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

async function summariseReport({ coordinator, worker, reportSeq, report }: ReportToSummarise): Promise<void> {
  if (!allowGeneration('workerReportSummary')) return;
  if (!report.trim()) return;
  const context = summaryContext(coordinator, worker, reportSeq);
  if (context.alreadySummarised) {
    logger.debug('Report already has a summary', { worker, reportSeq });
    return;
  }

  const client = backgroundTextClient.getClient('workerReportSummary');
  if (!client) {
    logger.debug('No Anthropic client; report cards show the report as stored', { worker });
    return;
  }

  // The whole report, never an excerpt. A summariser given a report with its
  // middle cut out writes a summary that is wrong about what it cannot see,
  // and it has no way to tell that is what happened.
  const prompt = buildSummaryPrompt(context.task, report.trim());
  const model = summaryModel();
  const started = Date.now();
  const response = await client.messages.create({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    thinking: THINKING,
    system: [{ type: 'text', text: prompt.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt.user }],
  });
  const durationMs = Date.now() - started;
  logSummaryCost(worker, model, response, durationMs);

  let actualModel = response.model || model;
  const firstReply = replyText(response);
  const draft = reportSummaryDraft(firstReply);
  if (!draft) {
    logger.debug('No usable report summary; the card shows the report as stored', { worker, model });
    return;
  }

  // Two things send a summary back, once, in one follow-up. A line over the
  // card's bounds used to lose the whole summary — about one report in seven —
  // when all it needed was shortening. And a summary that names something the
  // report does not say reads as right and is not. A second answer that still
  // has either problem is dropped, and the card shows the report as stored.
  const source = `${context.task ?? ''}\n${report}`;
  const tooLong = reportSummaryOverLimits(draft);
  const missing = summaryDetailsMissing({ title: draft.title, text: draft.points.join('\n') }, source);
  let summary = usableReportSummary(firstReply);
  if (!summary || missing.length > 0) {
    logger.info('Report summary sent back', { worker, reportSeq, tooLong, details: missing });
    const retryStarted = Date.now();
    const retry = await client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      thinking: THINKING,
      system: [{ type: 'text', text: prompt.system, cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: prompt.user },
        { role: 'assistant', content: firstReply },
        { role: 'user', content: sendBackRequest(tooLong, missing) },
      ],
    });
    logSummaryCost(worker, model, retry, Date.now() - retryStarted);
    actualModel = retry.model || model;
    const second = usableReportSummary(replyText(retry));
    const stillMissing = second ? summaryDetailsMissing(second, source) : [];
    if (!second || stillMissing.length > 0) {
      const secondDraft = second ? null : reportSummaryDraft(replyText(retry));
      logger.info('Report summary dropped: the second answer still does not fit or still names details not in the report', {
        worker,
        reportSeq,
        tooLong: secondDraft ? reportSummaryOverLimits(secondDraft) : [],
        details: stillMissing,
      });
      return;
    }
    summary = second;
  }

  const manager = getHarnessSessionManager();
  if (!manager) {
    logger.warn('No harness session manager; report summary dropped', { coordinator, worker });
    return;
  }
  appendCustomHarnessEvent(manager, coordinator, WORKER_REPORT_SUMMARY_EVENT, {
    worker,
    reportSeq,
    title: summary.title,
    text: summary.text,
    model: actualModel,
  } satisfies WorkerReportSummaryData);
  logger.info('Report summary written', { worker, reportSeq, model, ms: durationMs, title: summary.title });
}

function replyText(response: Anthropic.Message): string {
  return response.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

/** The follow-up that names what was wrong with the first summary. Exported for tests. */
export function sendBackRequest(tooLong: string[], missing: string[]): string {
  const parts: string[] = [];
  if (tooLong.length > 0) {
    parts.push(`Your summary does not fit the card. ${tooLong.join(' ')} Shorten it by saying less, not by cutting words ` +
      'off: drop the least important fact or clause rather than leave a line unfinished.');
  }
  if (missing.length > 0) {
    parts.push(`Your summary writes ${missing.map((d) => `"${d}"`).join(', ')}, which the report does not contain. ` +
      'Copy every name, number and id exactly as the report writes it, or describe it in plain words.');
  }
  parts.push('Write it again in the same shape.');
  return parts.join('\n\n');
}

function logSummaryCost(worker: string, model: string, response: Anthropic.Message, durationMs: number): void {
  try {
    getCostTracker().log({
      sessionId: worker,
      operation: 'WORKER_REPORT_SUMMARY',
      ...backgroundProvenance(response, model),
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      cacheCreationInputTokens: response.usage?.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: response.usage?.cache_read_input_tokens ?? 0,
      durationMs,
    });
  } catch (err) {
    logger.debug('Cost tracking failed', { error: err });
  }
}
