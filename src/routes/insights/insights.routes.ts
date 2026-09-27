/**
 * Session insights routes.
 *
 * Endpoints:
 * - GET  /:sessionId/insights                   - Get insights for a session
 * - POST /:sessionId/review                     - Run a session review
 * - GET  /:sessionId/turns                      - Captured turns for a session
 * - GET  /:sessionId/turns/:turnNumber/message-id
 * - POST /recommendations/accept
 * - POST /recommendations/:id/dismiss
 * - POST /recommendations/:id/complete
 * - GET  /recommendations/pending
 */

import { Router } from 'express';
import { RequestWithRequestId } from '@/types/express.js';
import { SessionReviewService, type ReviewProvider } from '@/services/sessions/session-review-service.js';
import { TurnCaptureService } from '@/services/sessions/turn-capture-service.js';
import { createLogger } from '@/services/infrastructure/logger.js';
import { InsightsEngine } from '@/services/insights/insights-engine.js';
import { asyncHandler } from '@/middleware/error-handler.js';

interface AcceptRecommendationBody {
  id: string;
  sessionId: string;
  target: string;
  improvementType?: string;
  friction: string;
  action: string;
  rationale: string;
  projectPath?: string;
  userNote?: string;
  sourceProject?: string;
  sourceMission?: string;
}


export function createInsightsRoutes(): Router {
  const router = Router();
  const logger = createLogger('InsightsRoutes');
  const insightsEngine = InsightsEngine.getInstance();
  const reviewService = SessionReviewService.getInstance();
  const turnCaptureService = TurnCaptureService.getInstance();
  router.get('/:sessionId/insights', asyncHandler(async (req: RequestWithRequestId, res) => {
    const requestId = req.requestId;
    const { sessionId } = req.params;
    const quick = String(req.query.quick) === 'true';

    logger.debug('[API] Get insights request', {
      requestId,
      sessionId: sessionId.slice(0, 8),
      quick,
      timestamp: new Date().toISOString()
    });

    const insights = quick
      ? await insightsEngine.getInsightsQuick(sessionId)
      : await insightsEngine.getInsights(sessionId);

    logger.debug('[API] Insights retrieved and returning', {
      requestId,
      sessionId: sessionId.slice(0, 8),
      hasInsights: !!insights,
      hasMission: !!insights.context?.mission,
      mission: insights.context?.mission,
      theme: insights.theme
    });

    res.json(insights);
  }));

  router.post('/:sessionId/review', asyncHandler(async (req: RequestWithRequestId, res) => {
    const requestId = req.requestId;
    const { sessionId } = req.params;
    const forceRefresh = String(req.query.force) === 'true';
    const provider = (req.query.provider === 'gemini' ? 'gemini' : 'opus') as ReviewProvider;

    logger.info('Starting session review analysis', {
      requestId,
      sessionId: sessionId.slice(0, 8),
      forceRefresh,
      provider,
      queryForce: req.query.force,
      queryString: req.originalUrl,
    });

    try {
      const review = await reviewService.analyzeForReview(sessionId, forceRefresh, provider);

      logger.info('Session review complete', {
        requestId,
        sessionId: sessionId.slice(0, 8),
        provider,
        recommendationCount: review.recommendations.length,
      });

      res.json(review);
    } catch (error) {
      logger.error('Session review failed', error instanceof Error ? error : new Error(String(error)), {
        requestId,
        sessionId: sessionId.slice(0, 8),
        provider,
        forceRefresh,
      });
      res.status(500).json({
        error: 'Session review failed',
        message: error instanceof Error ? error.message : String(error),
        sessionId: sessionId.slice(0, 8),
      });
    }
  }));

  router.get('/:sessionId/turns', asyncHandler(async (req: RequestWithRequestId, res) => {
    const requestId = req.requestId;
    const { sessionId } = req.params;

    logger.debug('Get session turns', {
      requestId,
      sessionId: sessionId.slice(0, 8),
    });

    const turns = await turnCaptureService.getTurnsForSession(sessionId);

    logger.debug('Turns retrieved', {
      requestId,
      sessionId: sessionId.slice(0, 8),
      turnCount: turns.length,
    });

    res.json({ turns });
  }));

  router.get('/:sessionId/turns/:turnNumber/message-id', asyncHandler(async (req: RequestWithRequestId, res) => {
    const requestId = req.requestId;
    const { sessionId, turnNumber: turnNumberParam } = req.params;
    const turnNumber = Number.parseInt(turnNumberParam, 10);

    if (!Number.isFinite(turnNumber) || turnNumber < 1) {
      res.status(400).json({ error: 'turnNumber must be a positive integer' });
      return;
    }

    logger.debug('Get turn anchor message ID', {
      requestId,
      sessionId: sessionId.slice(0, 8),
      turnNumber,
    });

    const messageId = await turnCaptureService.getTurnAnchorMessageId(sessionId, turnNumber);

    logger.debug('Turn anchor lookup complete', {
      requestId,
      sessionId: sessionId.slice(0, 8),
      turnNumber,
      found: !!messageId,
    });

    res.json({ messageId });
  }));

  router.post('/recommendations/accept', asyncHandler(async (req: RequestWithRequestId<AcceptRecommendationBody>, res) => {
    const requestId = req.requestId;
    const { id, sessionId, target, improvementType, friction, action, rationale, projectPath, userNote, sourceProject, sourceMission } = req.body;

    logger.info('Accepting recommendation', {
      requestId,
      recommendationId: id,
      sessionId: sessionId?.slice(0, 8),
      target,
      improvementType,
      sourceProject,
      hasUserNote: !!userNote,
    });

    if (!id || !sessionId || !target || !friction || !action) {
      res.status(400).json({ error: 'Missing required fields: id, sessionId, target, friction, action' });
      return;
    }

    await reviewService.acceptRecommendation({
      id,
      sessionId,
      target,
      improvementType: improvementType ?? null,
      friction,
      action,
      rationale,
      projectPath: projectPath ?? null,
      userNote: userNote ?? null,
      sourceProject: sourceProject ?? null,
      sourceMission: sourceMission ?? null,
    });

    logger.info('Recommendation accepted', { requestId, recommendationId: id, target, projectPath, hasUserNote: !!userNote });
    res.json({ success: true, id });
  }));

  router.post('/recommendations/:id/dismiss', asyncHandler(async (req: RequestWithRequestId, res) => {
    const requestId = req.requestId;
    const { id } = req.params;

    logger.info('Dismissing recommendation', { requestId, recommendationId: id });

    await reviewService.dismissRecommendation(id);
    logger.info('Recommendation dismissed', { requestId, recommendationId: id });
    res.json({ success: true, id });
  }));

  router.post('/recommendations/:id/complete', asyncHandler(async (req: RequestWithRequestId, res) => {
    const requestId = req.requestId;
    const { id } = req.params;

    logger.info('Completing recommendation', { requestId, recommendationId: id });

    await reviewService.completeRecommendation(id);
    logger.info('Recommendation completed', { requestId, recommendationId: id });
    res.json({ success: true, id });
  }));

  router.get('/recommendations/pending', asyncHandler(async (req: RequestWithRequestId, res) => {
    const requestId = req.requestId;
    logger.debug('Getting pending recommendations', { requestId });

    const recommendations = await reviewService.getPendingRecommendations();
    logger.debug('Pending recommendations retrieved', {
      requestId,
      count: recommendations.length,
    });
    res.json({ recommendations });
  }));

  return router;
}
