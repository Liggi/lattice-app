/**
 * Work a session will resume on its own, without the user typing anything.
 *
 * A session that fired off a background command, a subagent, or a scheduled
 * wakeup and then ended its turn is *idle* by the status endpoint's definition
 * — no turn is streaming. But it isn't idle in the sense the sidebar cares
 * about: something is still running, and the session will speak again by
 * itself. Grouping those under "Idle" hides live work next to conversations
 * nobody has touched all day.
 *
 * This lives here rather than in the harness protocol on purpose. The harness
 * already has `deriveBackgroundTasks`, but it deliberately tracks only
 * `local_bash`, because subagent and workflow tasks have their own lifecycle
 * and their own rendering via TaskTool. That scoping is right for rendering a
 * background-task tray and wrong for asking "will this session wake up on its
 * own?", which needs every task type. Rather than widen a harness function
 * whose narrowness other call sites depend on, liveness gets its own pass.
 */

import { deriveScheduledWakeup } from '@liggi/agent-ui-harness/protocol';
import type {
  SessionEvent,
  TaskStartedData,
  TaskUpdatedData,
  TaskNotificationData,
} from '@liggi/agent-ui-harness/protocol';

export type PendingWork = 'background_task' | 'subagent' | 'workflow' | 'scheduled_wakeup';

const PENDING_WORK_BY_TASK_TYPE: Record<string, PendingWork> = {
  local_bash: 'background_task',
  local_agent: 'subagent',
  local_workflow: 'workflow',
};

/**
 * The kind of outstanding work holding this session open, or null if nothing
 * is. When several kinds are outstanding, the first still-running task wins;
 * a scheduled wakeup is only reported when no task is running, since a task
 * finishing is the nearer-term event.
 */
export function derivePendingWork(events: readonly SessionEvent[]): PendingWork | null {
  const running = new Map<string, PendingWork>();

  for (const event of events) {
    // Process boundaries orphan every running task, exactly as
    // deriveBackgroundTasks treats them: the channel that would have delivered
    // the terminal task:updated died with the process.
    if (event.type === 'run:start' || event.type === 'run:end' || event.type === 'run:error') {
      running.clear();
      continue;
    }

    if (event.type === 'task:started') {
      const data = event.data as TaskStartedData;
      // An unrecognised task type still means something is running. Defaulting
      // to 'background_task' keeps a new harness task type visible in the
      // sidebar instead of silently reading as idle.
      running.set(data.taskId, PENDING_WORK_BY_TASK_TYPE[data.taskType] ?? 'background_task');
    } else if (event.type === 'task:updated') {
      const data = event.data as TaskUpdatedData;
      // Only 'running' keeps a task alive — completed, failed, killed and any
      // future terminal status all mean it is done.
      if (data.patch?.status !== 'running') running.delete(data.taskId);
    } else if (event.type === 'task:notification') {
      running.delete((event.data as TaskNotificationData).taskId);
    }
  }

  const firstRunning = running.values().next();
  if (!firstRunning.done) return firstRunning.value;

  return deriveScheduledWakeup(events) ? 'scheduled_wakeup' : null;
}
