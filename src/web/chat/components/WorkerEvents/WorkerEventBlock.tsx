/**
 * Thread blocks for a coordinator's worker events (see
 * `src/types/worker-events.ts`). Three shapes:
 *
 * - started:  a bordered block naming the worker and its task.
 * - answered: one quiet, borderless line with the substance of what the
 *             coordinator told the worker; the exchange opens on click.
 * - reported: a bordered block led by a result title and two to four short
 *             lines, one fact each (the server's summary, see
 *             `services/sessions/worker-report-summary.ts`), with the report
 *             itself underneath on Full report and a way into the worker's
 *             session. A report with no summary — everything before
 *             2026-09-21, and anything written while the generation gate is
 *             closed — shows the report itself, clipped and expandable, which
 *             is what every report did before.
 *             The server stores the reply the worker ended its turn on;
 *             events from before 2026-09-20 hold the whole turn, progress
 *             lines first, and show that as stored.
 *
 * A worker's question is never a thread item — the Workers panel shows it
 * while it is open (2026-09-19 flow agreement).
 */

import React, { useState } from 'react';
import { ArrowRightLeft, ChevronDown, ChevronRight, ExternalLink, MessageSquare, Play, SquarePen } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownComponents } from '../MessageList/MessageItem';
import { AddReactionButton, ReactionChips, firstLine, type ReactionTarget } from '../MessageReactions/MessageReactions';
import type { ChatMessage } from '../../types';
import { reportSummaryPoints, stripWorkerQuestionMarker, type WorkerAnsweredData, type WorkerMovedData, type WorkerReassignedData, type WorkerReportedData, type WorkerReportSummaryData, type WorkerStartedData } from '@/types/worker-events';

interface WorkerEventBlockProps {
  message: ChatMessage;
  onNavigateToSession?: (sessionId: string) => void;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function providerLabel(provider: string): string {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  return provider;
}

const PROSE = 'prose max-w-none text-sm leading-[1.55] dark:prose-invert';

export function WorkerEventBlock({ message, onNavigateToSession }: WorkerEventBlockProps): JSX.Element | null {
  const event = message.workerEvent;
  if (!event) return null;
  const time = formatTime(message.timestamp);

  switch (event.type) {
    case 'worker:started':
      return <StartedBlock data={event.data as WorkerStartedData} time={time} onNavigateToSession={onNavigateToSession} />;
    case 'worker:reassigned':
      return <ReassignedLine data={event.data as WorkerReassignedData} time={time} />;
    case 'worker:moved':
      return <MovedLine data={event.data as WorkerMovedData} time={time} />;
    case 'worker:answered':
      return <AnsweredLine data={event.data as WorkerAnsweredData} time={time} />;
    case 'worker:reported':
      // A repeated wait the coordinator was not sent; the card shows it.
      if ((event.data as WorkerReportedData).quietRepeat) return null;
      return (
        <ReportedBlock
          messageId={message.messageId}
          data={event.data as WorkerReportedData}
          summary={event.reportSummary ?? null}
          time={time}
          onNavigateToSession={onNavigateToSession}
        />
      );
    default:
      return null;
  }
}

function StartedBlock({
  data,
  time,
  onNavigateToSession,
}: {
  data: WorkerStartedData;
  time: string;
  onNavigateToSession?: (sessionId: string) => void;
}) {
  return (
    <div data-testid="worker-started" className="rounded-lg border border-line bg-surface px-3.5 py-2.5">
      <div className="flex items-center gap-2 text-[12.5px] text-fg-3">
        <Play size={13} className="text-fg-3" />
        <span className="font-medium text-fg-2">{providerLabel(data.provider)} worker</span>
        {data.model && <span>{data.model}</span>}
        <span className="flex-1" />
        {time && <span>{data.movedFrom ? `Moved here from ${data.movedFrom.project ?? data.movedFrom.coordinator} ${time}` : `Started ${time}`}</span>}
        {onNavigateToSession && (
          <button
            type="button"
            onClick={() => onNavigateToSession(data.worker)}
            className="inline-flex items-center gap-1 text-fg-3 hover:text-fg"
            title="Open the worker's session"
          >
            <ExternalLink size={12} />
          </button>
        )}
      </div>
      <div className="mt-1 text-sm text-fg">{data.task}</div>
    </div>
  );
}

/**
 * The coordinator moved a worker on to something else. One line and nothing
 * to expand: the whole event is the new task, and the brief that came with it
 * is the `worker:answered` directly below. The old name is shown struck
 * through beside it so the thread reads as the change rather than as a second
 * dispatch — the dispatch block above still stands where it happened.
 */
function ReassignedLine({ data, time }: { data: WorkerReassignedData; time: string }) {
  return (
    <div
      data-testid="worker-reassigned"
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-fg-2"
    >
      <SquarePen size={14} className="shrink-0 text-fg-3" />
      <span className="min-w-0 flex-1 leading-[1.4]">
        <span className="font-medium text-fg">Moved the worker on to</span>
        <span> · {data.task}</span>
        {data.previousTask && <span className="text-fg-3"> (was {data.previousTask})</span>}
      </span>
      {time && <span className="shrink-0 text-xs text-fg-3">{time}</span>}
    </div>
  );
}

/**
 * The worker left for another project (`session move-worker`). Its card goes
 * from this panel; this line is where the thread says where it went.
 */
function MovedLine({ data, time }: { data: WorkerMovedData; time: string }) {
  return (
    <div
      data-testid="worker-moved"
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-fg-2"
    >
      <ArrowRightLeft size={14} className="shrink-0 text-fg-3" />
      <span className="min-w-0 flex-1 leading-[1.4]">
        <span className="font-medium text-fg">Moved the worker to {data.project ?? data.to}</span>
        <span> · {data.task}</span>
      </span>
      {time && <span className="shrink-0 text-xs text-fg-3">{time}</span>}
    </div>
  );
}

function AnsweredLine({ data, time }: { data: WorkerAnsweredData; time: string }) {
  const [open, setOpen] = useState(false);
  const verb = data.passedOn ? 'Passed on to the worker'
    : data.question ? 'Coordinator answered the worker'
    : 'Coordinator told the worker';
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div data-testid="worker-answered" className={`rounded-lg ${open ? 'bg-surface' : ''}`}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-fg-2 hover:bg-surface-2"
      >
        <MessageSquare size={14} className="shrink-0 text-fg-3" />
        <span className="min-w-0 flex-1 leading-[1.4]">
          <span className="font-medium text-fg">{verb}</span>
          {data.summary && <span> · {data.summary}</span>}
        </span>
        {time && <span className="shrink-0 text-xs text-fg-3">{time}</span>}
        <Chevron size={13} className="shrink-0 text-fg-3" />
      </button>
      {open && (
        <div className="flex flex-col gap-3 px-3 pb-3 pt-1 pl-[33px] text-[13px] leading-[1.45] text-fg">
          {data.question && (
            <div className="flex flex-col gap-0.5">
              <div className="text-[11.5px] font-medium text-fg-3">Worker asked</div>
              <div className={PROSE}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{stripWorkerQuestionMarker(data.question)}</ReactMarkdown>
              </div>
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            <div className="text-[11.5px] font-medium text-fg-3">{data.passedOn ? 'Coordinator, passing on your answer' : 'Coordinator'}</div>
            <div className={PROSE}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{data.text}</ReactMarkdown>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const REPORT_CLIP_PX = 176;

/**
 * The summary: a result line, then the facts under it one per line. A single
 * fact is written as a plain line rather than a list of one, which is what a
 * summary written before 2026-09-21 (a paragraph) also renders as.
 */
function SummaryLines({ title, text }: { title: string; text: string }) {
  const points = reportSummaryPoints(text);
  return (
    <div className="mt-1.5" data-testid="worker-report-summary">
      <div className="text-sm font-medium leading-[1.4] text-fg">{title}</div>
      {points.length === 1 ? (
        <div className="mt-1 text-[13px] leading-[1.5] text-fg-2">{points[0]}</div>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1">
          {points.map((point, index) => (
            <li key={index} className="flex gap-2 text-[13px] leading-[1.5] text-fg-2">
              <span aria-hidden className="mt-[7px] h-[3px] w-[3px] shrink-0 rounded-full bg-fg-3" />
              <span className="min-w-0">{point}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A report card. What it leads with depends on whether the server has written
 * a summary for this report yet:
 *
 * - With one: the result title, then one fact per line, and the report itself
 *   only on Full report. The point of the card is that the user can follow the
 *   thread without opening anything, and a line per fact is what makes it
 *   scannable rather than a second paragraph to read.
 * - Without one: the report, clipped and expandable, as before. Reports
 *   predating the summary writer and reports written while its gate is closed
 *   both land here, and neither is a broken card — nothing on it says a
 *   summary is missing.
 *
 * "Reported" stays on the card in both shapes. The summary is a shorter
 * retelling of the worker's own claim, not a finding anyone has checked, and
 * the label plus the report underneath it are what keep that visible.
 */
function ReportedBlock({
  messageId,
  data,
  summary,
  time,
  onNavigateToSession,
}: {
  messageId: string;
  data: WorkerReportedData;
  summary: WorkerReportSummaryData | null;
  time: string;
  onNavigateToSession?: (sessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const bodyRef = React.useCallback((node: HTMLDivElement | null) => {
    if (node) setClipped(node.scrollHeight > REPORT_CLIP_PX + 8);
  }, []);
  // With a summary the report is hidden rather than clipped, so there is
  // always something behind Full report and no measurement to make.
  const showsReport = summary === null || expanded;
  const canToggle = summary !== null || clipped || expanded;
  const reaction: ReactionTarget = { messageId, excerpt: summary?.title ?? firstLine(data.text), worker: data.worker };
  return (
    <div data-testid="worker-reported" className="rounded-lg border border-line bg-surface px-3.5 py-2.5">
      <div className="flex items-center gap-2 text-[12.5px]">
        <span className="font-medium text-fg-2">Reported</span>
        {data.movedFrom && (
          <span className="text-[11px] text-fg-3">carried over from {data.movedFrom.project ?? data.movedFrom.coordinator}</span>
        )}
        <span className="flex-1" />
        {data.model && <span className="text-[11px] text-fg-3">{data.model}</span>}
        {time && <span className="text-[11px] text-fg-3">{time}</span>}
      </div>
      {summary && <SummaryLines title={summary.title} text={summary.text} />}
      {showsReport && (
        <div className={`relative ${summary ? 'mt-3 border-t border-line pt-2.5' : 'mt-1.5'}`}>
          <div
            ref={summary ? undefined : bodyRef}
            className={PROSE}
            style={expanded ? undefined : { maxHeight: REPORT_CLIP_PX, overflow: 'hidden' }}
            data-testid="worker-report-body"
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{data.text}</ReactMarkdown>
          </div>
          {!expanded && clipped && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface to-transparent" />
          )}
        </div>
      )}
      <div className="mt-2 flex items-center gap-3 border-t border-line pt-2 text-xs">
        {canToggle && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="font-medium text-fg-2 hover:text-fg"
          >
            {expanded ? 'Show less' : 'Full report'}
          </button>
        )}
        {canToggle && onNavigateToSession && <span className="text-fg-3">·</span>}
        {onNavigateToSession && (
          <button
            type="button"
            onClick={() => onNavigateToSession(data.worker)}
            className="font-medium text-fg-2 hover:text-fg"
          >
            Open agent session
          </button>
        )}
        <span className="flex-1" />
        <ReactionChips target={reaction} className="-my-1" />
        <AddReactionButton target={reaction} className="-my-1" />
      </div>
    </div>
  );
}
