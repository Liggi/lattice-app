import { Router, type Request, type Response } from 'express';
import { describeSkill } from '@/services/infrastructure/skill-catalog.js';
import type { ConversationService } from '@/services/sessions/conversation-service.js';

export function createSkillsRoutes(deps: { conversationService?: ConversationService }): Router {
  const router = Router();

  /**
   * GET /api/skills/describe?name=<skill>&conversationId=<conv>
   * The conversation's folder is where Claude found the project's own skills.
   */
  router.get('/describe', (req: Request, res: Response) => {
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : '';
    if (!name || name.includes('/') || name.includes('..')) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const cwd = conversationId ? deps.conversationService?.getConversation(conversationId)?.workingDirectory : undefined;
    res.json(describeSkill(name, cwd || undefined));
  });

  return router;
}
