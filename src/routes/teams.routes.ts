/**
 * Teams Routes - Agent Teams observability API
 *
 * Provides read-only access to Claude Code Agent Teams state.
 */

import { Router, type Request, type Response } from 'express';
import { createLogger } from '../services/infrastructure/logger.js';
import { getTeamWatcherService } from '../services/teams/team-watcher-service.js';
import { asyncHandler } from '@/middleware/error-handler.js';

export function createTeamsRoutes(): Router {
  const router = Router();
  const logger = createLogger('TeamsRoutes');
  const teamWatcher = getTeamWatcherService();

  /**
   * GET /api/teams
   * List all active teams.
   */
  router.get('/', asyncHandler(async (_req: Request, res: Response) => {
    const teams = await teamWatcher.listTeams();
    logger.debug('Retrieved team list', { count: teams.length });
    res.json({ teams });
  }));

  /**
   * GET /api/teams/:teamName/inboxes
   * Get inbox summaries for a team.
   */
  router.get('/:teamName/inboxes', asyncHandler(async (req: Request, res: Response) => {
    const { teamName } = req.params;
    if (!teamName) {
      res.status(400).json({ error: 'Team name is required' });
      return;
    }

    const teamInfo = await teamWatcher.getTeamInfo(teamName);
    if (!teamInfo) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }

    const inboxes = teamInfo.inboxSummaries ?? await teamWatcher.getInboxSummaries(teamName);
    res.json({ teamName, inboxes });
  }));

  /**
   * GET /api/teams/:teamName
   * Get team info including members and task status
   */
  router.get('/:teamName', asyncHandler(async (req: Request, res: Response) => {
    const { teamName } = req.params;

    if (!teamName) {
      res.status(400).json({ error: 'Team name is required' });
      return;
    }

    const teamInfo = await teamWatcher.getTeamInfo(teamName);

    if (!teamInfo) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }

    logger.debug('Retrieved team info', {
      teamName,
      memberCount: teamInfo.memberCount,
      taskTotal: teamInfo.tasks.pending + teamInfo.tasks.in_progress + teamInfo.tasks.completed
    });

    res.json(teamInfo);
  }));

  return router;
}
