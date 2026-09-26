import React, { createContext, useContext, useMemo, useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../services/api';
import { useActivityStreamSubscription } from './ActivityStreamContext';

/**
 * Provides a mapping of agent name → color string for team-colored tool rendering.
 * Set at the ConversationView level when the session belongs to a team.
 */

interface TeamColorContextValue {
  /** Map of agent name → color (e.g., "researcher" → "blue") */
  agentColors: Record<string, string>;
  /** The team name, if any */
  teamName: string | null;
}

const TeamColorContext = createContext<TeamColorContextValue>({
  agentColors: {},
  teamName: null,
});

/** Read the full team color context. */
export function useTeamColorContext(): TeamColorContextValue {
  return useContext(TeamColorContext);
}

interface TeamColorProviderProps {
  teamName: string | null;
  children: React.ReactNode;
}

/**
 * Fetches team config when teamName is set and provides agent colors
 * to all tool renderers via context. Subscribes to team-updated SSE
 * events to refresh when members join/leave.
 */
export function TeamColorProvider({ teamName, children }: TeamColorProviderProps): JSX.Element {
  const [agentColors, setAgentColors] = useState<Record<string, string>>({});
  const teamNameRef = useRef(teamName);
  teamNameRef.current = teamName;

  const fetchColors = useCallback(async () => {
    if (!teamNameRef.current) {
      setAgentColors({});
      return;
    }
    try {
      const info = await api.getTeamInfo(teamNameRef.current);
      if (!info?.config?.members) return;
      const colors: Record<string, string> = {};
      for (const member of info.config.members) {
        if (member.color) {
          colors[member.name] = member.color;
        }
      }
      setAgentColors(colors);
    } catch {
      // Team might not exist yet or API might be unavailable
    }
  }, []);

  // Fetch on mount and when teamName changes
  useEffect(() => {
    if (teamName) {
      void fetchColors();
    } else {
      setAgentColors({});
    }
  }, [teamName, fetchColors]);

  // Refresh when team events arrive
  useActivityStreamSubscription(
    useMemo(() => ({ type: 'activity' }), []),
    useCallback((event: unknown) => {
      if (!teamName || typeof event !== 'object' || event === null || !('type' in event)) {
        return;
      }

      const eventType = (event as { type?: unknown }).type;
      if (eventType === 'team-updated' || eventType === 'team-inbox-update') {
        void fetchColors();
      }
    }, [teamName, fetchColors])
  );

  const value = useMemo(() => ({
    agentColors,
    teamName,
  }), [agentColors, teamName]);

  return (
    <TeamColorContext.Provider value={value}>
      {children}
    </TeamColorContext.Provider>
  );
}
