/**
 * Side questions about a passage of an agent's message
 * (services/side-questions/side-questions.ts).
 *
 * - GET  /api/side-questions?conversationId=conv-…  every side chat in a conversation
 * - POST /api/side-questions                       open a new one: returns the side chat
 *                                                  and the first message to start it with
 * - POST /api/side-questions/:id/add-to-thread     add it to the thread as context
 *
 * The side chat itself is a hidden session, so everything after its creation
 * goes through the ordinary harness routes under its own conversation id.
 */

import { Router } from 'express';
import { asyncHandler } from '@/middleware/error-handler.js';
import {
  addSideQuestionToThread,
  createSideChat,
  listSideQuestions,
} from '@/services/side-questions/side-questions.js';

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function createSideQuestionRoutes(): Router {
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    const conversationId = text(req.query.conversationId);
    if (!conversationId) {
      res.status(400).json({ error: 'conversationId is required' });
      return;
    }
    res.json({ sideQuestions: listSideQuestions(conversationId) });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const conversationId = text(body.conversationId);
    const messageId = text(body.messageId);
    const quote = typeof body.quote === 'string' && body.quote.trim() ? body.quote : null;
    const question = text(body.question);
    if (!conversationId || !messageId || !quote || !question) {
      res.status(400).json({ error: 'conversationId, messageId, quote and question are required' });
      return;
    }
    const quoteStart = typeof body.quoteStart === 'number' ? body.quoteStart : null;
    res.json(await createSideChat({ conversationId, messageId, quote, quoteStart, question }));
  }));

  router.post('/:id/add-to-thread', asyncHandler(async (req, res) => {
    res.json({ sideQuestion: await addSideQuestionToThread(req.params.id) });
  }));

  return router;
}
