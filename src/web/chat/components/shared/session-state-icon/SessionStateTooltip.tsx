import type { JSX } from 'react';
import type { UnifiedConversationSummary } from '../../../types';
import { quietFor, type SessionActivity } from '../../../utils/session-activity';
import { lastUsedAt } from '../../../utils/sidebar-ordering';
import { SessionStateIcon } from './SessionStateIcon';

const MAX_WORKERS = 4;

const WAITING_LINES: Record<Exclude<NonNullable<UnifiedConversationSummary['pendingWork']>, 'scheduled_wakeup'>, string> = {
  background_task: 'Waiting for a command it left running',
  subagent: 'Waiting for a helper agent to finish',
  workflow: 'Waiting for a workflow to finish',
};

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The worker's task, as its card in the project's right panel names it; else the session's own name. */
function workerName(project: UnifiedConversationSummary, c: UnifiedConversationSummary): string {
  return project.projectWorkerTasks?.[c.conversationId]
    || c.customName?.trim() || c.insights?.context?.mission || c.insights?.purpose
    || c.initialPromptPreview?.split('\n')[0] || c.conversationId.slice(0, 12);
}

/** A project's Working on line; for a session, its purpose when that says more than its name. */
function workingOn(c: UnifiedConversationSummary): string | null {
  if (c.coordinator) return c.projectWorkingOn ?? null;
  const purpose = c.insights?.purpose?.trim();
  return purpose && purpose !== c.customName?.trim() ? purpose : null;
}

interface Heading { title: string; tone: string; meta?: string }

function heading(activity: SessionActivity, conversation: UnifiedConversationSummary, now: number): Heading {
  switch (activity.kind) {
    case 'needs-you': return { title: 'Needs you', tone: 'text-amber-400', meta: activity.asks?.length ? `${quietFor(now - activity.asks[0].since)} ago` : undefined };
    case 'failed': return { title: 'Failed', tone: 'text-rose-400', meta: conversation.failure ? `${quietFor(now - conversation.failure.at)} ago` : undefined };
    case 'compacting': return { title: 'Compacting', tone: 'text-violet-400' };
    case 'working': return { title: 'Working', tone: 'text-accent' };
    case 'waiting': return { title: 'Waiting', tone: 'text-accent' };
    case 'idle': return { title: 'Idle', tone: 'text-fg-2', meta: `last active ${quietFor(now - lastUsedAt(conversation))} ago` };
    case 'sleeping': return { title: 'Sleeping', tone: 'text-fg-2', meta: `last active ${quietFor(now - lastUsedAt(conversation))} ago` };
  }
}

function Body({ activity, conversation, conversations }: {
  activity: SessionActivity;
  conversation: UnifiedConversationSummary;
  conversations: UnifiedConversationSummary[];
}): JSX.Element | null {
  switch (activity.kind) {
    case 'needs-you':
      return activity.asks?.length
        ? (
          <ul className="space-y-1 text-fg">
            {activity.asks.map(item => <li key={item.seq}>{capitalised(item.text)}</li>)}
          </ul>
        )
        : <p>Asked you a question or for permission</p>;
    case 'failed':
      return (
        <div>
          <p className="text-[11px] text-fg-3">Last turn stopped:</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-fg">{activity.message}</p>
        </div>
      );
    case 'compacting':
      return <p>Summarising its history to make room, then carries on</p>;
    case 'working': {
      const busy = conversations.filter(c => c.pickedUpFrom === conversation.conversationId && !c.archived
        && (c.status === 'pending' || c.status === 'ongoing' || Boolean(c.pendingWork)));
      if (busy.length === 0) {
        const line = workingOn(conversation);
        return line ? <p className="text-fg">{line}</p> : null;
      }
      const more = busy.length - MAX_WORKERS;
      return (
        <div>
          <p>{busy.length} worker{busy.length === 1 ? '' : 's'} on it:</p>
          <ul className="mt-1.5 space-y-1.5 text-fg">
            {busy.slice(0, MAX_WORKERS).map(c => (
              <li key={c.conversationId} className="flex items-start gap-2 leading-snug">
                <span className="mt-px shrink-0 text-fg-3"><SessionStateIcon state={{ kind: 'idle' }} variant="session" size={14} /></span>
                <span className="min-w-0 break-words">{workerName(conversation, c)}</span>
              </li>
            ))}
            {more > 0 && <li className="pl-[22px] text-[11px] text-fg-3">+{more} more</li>}
          </ul>
        </div>
      );
    }
    case 'waiting':
      if (conversation.pendingWork === 'scheduled_wakeup') {
        return <p>{conversation.wakeAt ? `Checking back at ${clock(conversation.wakeAt)}` : 'Checking back later'}</p>;
      }
      return conversation.pendingWork ? <p>{WAITING_LINES[conversation.pendingWork]}</p> : null;
    case 'idle':
    case 'sleeping':
      return null;
  }
}

/** What a sidebar row's state icon means, in a small card: the state and what is behind it. */
export function SessionStateTooltip({ activity, conversation, conversations, now = Date.now() }: {
  activity: SessionActivity;
  conversation: UnifiedConversationSummary;
  conversations: UnifiedConversationSummary[];
  now?: number;
}): JSX.Element {
  const head = heading(activity, conversation, now);
  const body = Body({ activity, conversation, conversations });
  return (
    <div className={`text-xs ${body ? 'w-72' : 'min-w-40'}`}>
      <div className={`flex items-baseline gap-4 px-3 ${body ? 'pt-2 pb-1.5' : 'py-2'}`}>
        <span className={`font-medium ${head.tone}`}>{head.title}</span>
        {head.meta && <span className="ml-auto text-[11px] text-fg-3">{head.meta}</span>}
      </div>
      {body && <div className="px-3 pb-2 leading-relaxed text-fg-2">{body}</div>}
    </div>
  );
}
