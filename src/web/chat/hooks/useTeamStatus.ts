import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useActivityStreamSubscription } from '../contexts/ActivityStreamContext';
import { api, type TeamInfoResponse } from '../services/api';
import type { UnifiedConversationSummary } from '../types';

export type TeamAgentStatus = 'idle' | 'running' | 'completed';

export interface TeamAgentRuntime {
  agentName: string;
  color: string;
  status: TeamAgentStatus;
  messageCount: number;
  unreadCount: number;
  latestTimestamp: string | null;
}

export interface TeamRuntimeStatus {
  teamName: string;
  leadSessionId: string;
  memberCount: number;
  tasks: {
    pending: number;
    in_progress: number;
    completed: number;
  };
  progressPct: number;
  agents: TeamAgentRuntime[];
  counts: {
    idle: number;
    running: number;
    completed: number;
  };
  updatedAt: number;
}

const FALLBACK_AGENT_COLORS = ['blue', 'green', 'yellow', 'purple'];

/** Joins team names into a comparable key. A control char can't appear in a team name. */
const TEAM_KEY_SEPARATOR = '\u0000';

type TeamActivityEvent = {
  type: 'team-updated' | 'team-removed' | 'team-inbox-update';
  teamName: string;
};

function isTeamActivityEvent(value: unknown): value is TeamActivityEvent {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== 'string' || typeof record.teamName !== 'string') {
    return false;
  }
  return record.type === 'team-updated'
    || record.type === 'team-removed'
    || record.type === 'team-inbox-update';
}

function deriveAgentStatus(
  agentName: string,
  team: TeamInfoResponse
): TeamAgentStatus {
  // Primary signal: did this agent deliver results to the lead's inbox?
  const completion = team.agentCompletions?.find(c => c.agentName === agentName);
  if (completion?.deliveredToLead) {
    return 'completed';
  }

  // Secondary signal: task file status (unreliable — agents often skip TaskUpdate)
  const totalTasks = team.tasks.pending + team.tasks.in_progress + team.tasks.completed;
  if (totalTasks > 0 && team.tasks.completed >= totalTasks) {
    return 'completed';
  }

  // If tasks are in progress, assume the agent is running
  if (team.tasks.in_progress > 0) {
    return 'running';
  }

  // If tasks exist but none are in_progress/completed, agents haven't started yet
  if (totalTasks > 0 && team.tasks.pending > 0) {
    return 'running';
  }

  return 'idle';
}

function deriveRuntimeStatus(team: TeamInfoResponse): TeamRuntimeStatus {
  const inboxByAgent = new Map<string, { messageCount: number; unreadCount: number; latestTimestamp: string | null }>();
  for (const inbox of team.inboxSummaries || []) {
    inboxByAgent.set(inbox.agentName, {
      messageCount: inbox.messageCount,
      unreadCount: inbox.unreadCount,
      latestTimestamp: inbox.latestTimestamp,
    });
  }

  const agents = team.config.members
    .filter(m => m.agentType !== 'team-lead')
    .map((member, index) => {
      const inbox = inboxByAgent.get(member.name);
      const status = deriveAgentStatus(member.name, team);

      return {
        agentName: member.name,
        color: member.color || FALLBACK_AGENT_COLORS[index % FALLBACK_AGENT_COLORS.length],
        status,
        messageCount: inbox?.messageCount ?? 0,
        unreadCount: inbox?.unreadCount ?? 0,
        latestTimestamp: inbox?.latestTimestamp ?? null,
      } satisfies TeamAgentRuntime;
    });

  const counts = agents.reduce(
    (acc, agent) => {
      acc[agent.status] += 1;
      return acc;
    },
    { idle: 0, running: 0, completed: 0 }
  );

  // Progress: prefer inbox-derived completion (reliable) over task file status (unreliable).
  // Agents often fail to call TaskUpdate, but they reliably send results to the lead's inbox.
  const inboxCompletedCount = team.agentCompletions?.filter(a => a.deliveredToLead).length ?? 0;
  const totalAgents = agents.length;
  const taskTotal = team.tasks.pending + team.tasks.in_progress + team.tasks.completed;
  const taskCompleted = team.tasks.completed;

  let progressPct: number;
  if (inboxCompletedCount > 0 && totalAgents > 0) {
    // Inbox-based progress (primary — most reliable)
    progressPct = Math.min(100, Math.round((inboxCompletedCount / totalAgents) * 100));
  } else if (taskTotal > 0) {
    // Task-file-based progress (fallback)
    progressPct = Math.min(100, Math.round((taskCompleted / taskTotal) * 100));
  } else {
    progressPct = 0;
  }

  return {
    teamName: team.teamName,
    leadSessionId: team.leadSessionId,
    memberCount: team.memberCount,
    tasks: team.tasks,
    progressPct,
    agents,
    counts,
    updatedAt: team.timestamp,
  };
}

export function useTeamStatus(conversations: UnifiedConversationSummary[]): {
  teamStatuses: Record<string, TeamRuntimeStatus>;
} {
  const [teamStatuses, setTeamStatuses] = useState<Record<string, TeamRuntimeStatus>>({});
  const mountedRef = useRef(true);
  const refreshStateRef = useRef<Map<string, { inFlight: boolean; pending: boolean }>>(new Map());

  // Callers routinely pass a freshly derived array (filtered/sorted conversations),
  // so memoizing on `conversations` identity alone never hits and the refresh effect
  // below would re-fire every render. Collapse the set to a stable string key first:
  // the key only changes when the actual set of team names changes, which is the only
  // thing the refresh effect cares about.
  const trackedTeamKey = useMemo(() => {
    const names = new Set<string>();
    for (const conversation of conversations) {
      const normalizedName = conversation.teamName?.trim();
      if (normalizedName) {
        names.add(normalizedName);
      }
    }
    return Array.from(names).sort().join(TEAM_KEY_SEPARATOR);
  }, [conversations]);

  const trackedTeamNames = useMemo(
    () => (trackedTeamKey === '' ? [] : trackedTeamKey.split(TEAM_KEY_SEPARATOR)),
    [trackedTeamKey]
  );

  const performRefresh = useCallback(async (teamName: string): Promise<void> => {
    const state = refreshStateRef.current.get(teamName) || { inFlight: false, pending: false };
    if (state.inFlight) {
      state.pending = true;
      refreshStateRef.current.set(teamName, state);
      return;
    }

    state.inFlight = true;
    state.pending = false;
    refreshStateRef.current.set(teamName, state);

    try {
      const teamInfo = await api.getTeamInfo(teamName);
      if (!mountedRef.current) return;
      const nextStatus = deriveRuntimeStatus(teamInfo);
      setTeamStatuses((prev) => ({ ...prev, [teamName]: nextStatus }));
    } catch (_error) {
      if (!mountedRef.current) return;
    } finally {
      const latest = refreshStateRef.current.get(teamName);
      if (latest) {
        if (latest.pending) {
          latest.pending = false;
          latest.inFlight = false;
          refreshStateRef.current.set(teamName, latest);
          void performRefresh(teamName);
        } else {
          latest.inFlight = false;
          refreshStateRef.current.set(teamName, latest);
        }
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const trackedSet = new Set(trackedTeamNames);

    setTeamStatuses((prev) => {
      const next: Record<string, TeamRuntimeStatus> = {};
      for (const [teamName, status] of Object.entries(prev)) {
        if (trackedSet.has(teamName)) {
          next[teamName] = status;
        }
      }
      return next;
    });

    for (const teamName of trackedTeamNames) {
      void performRefresh(teamName);
    }
  }, [trackedTeamNames, performRefresh]);

  useActivityStreamSubscription({ type: 'activity' }, (payload) => {
    if (!isTeamActivityEvent(payload)) {
      return;
    }

    if (payload.type === 'team-removed') {
      setTeamStatuses((prev) => {
        if (!(payload.teamName in prev)) return prev;
        const next = { ...prev };
        delete next[payload.teamName];
        return next;
      });
      return;
    }

    void performRefresh(payload.teamName);
  });

  return { teamStatuses };
}
