import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { CONFIG_DIR } from '@/utils/constants.js';

const FEEDBACK_DIR = path.join(CONFIG_DIR, 'feedback');
const FEEDBACK_FILE = path.join(FEEDBACK_DIR, 'feedback.jsonl');

interface FeedbackSubmitBody {
  category?: string;
  message?: string;
  findings?: unknown;
  conversationId?: string;
  investigationConversationId?: string;
  timestamp?: string;
  userAgent?: string;
}

export function createFeedbackRoutes(): Router {
  const router = Router();

  router.post('/submit', (req: Request, res: Response) => {
    try {
      const body = req.body as FeedbackSubmitBody;
      const { category, message, findings, conversationId, investigationConversationId, timestamp, userAgent } = body;

      if (!message || typeof message !== 'string' || !message.trim()) {
        res.status(400).json({ error: 'Message is required.' });
        return;
      }

      const entry = {
        id: `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        category: category || 'other',
        message: message.trim(),
        findings: findings || null,
        conversationId: conversationId || null,
        investigationConversationId: investigationConversationId || null,
        timestamp: timestamp || new Date().toISOString(),
        userAgent: userAgent || null,
        receivedAt: new Date().toISOString(),
      };

      fs.mkdirSync(FEEDBACK_DIR, { recursive: true });
      fs.appendFileSync(FEEDBACK_FILE, JSON.stringify(entry) + '\n', 'utf-8');

      console.warn(`[feedback] Saved feedback ${entry.id}: ${String(entry.category)} — "${entry.message.slice(0, 80)}"`);

      res.json({ id: entry.id, status: 'saved' });
    } catch (err) {
      console.error('[feedback] Failed to save feedback:', err);
      res.status(500).json({ error: 'Failed to save feedback.' });
    }
  });

  return router;
}
