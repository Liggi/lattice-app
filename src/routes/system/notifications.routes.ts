import { Router } from 'express';
import type { PushSubscription } from 'web-push';
import { WebPushService } from '@/services/web-push-service.js';
import { asyncHandler } from '@/middleware/error-handler.js';

export function createNotificationRoutes(): Router {
  const router = Router();
  const webPush = WebPushService.getInstance();

  // GET /api/notifications/status - Check push notification status
  router.get('/status', asyncHandler(async (_req, res) => {
    await webPush.initialize();
    const publicKey = webPush.getPublicKey();
    res.json({
      enabled: webPush.getEnabled(),
      subscriptionCount: webPush.getSubscriptionCount(),
      hasPublicKey: !!publicKey,
      publicKey: publicKey || undefined,
    });
  }));

  // POST /api/notifications/register - Register a push subscription
  router.post('/register', asyncHandler(async (req, res) => {
    await webPush.initialize();
    const subscription = req.body as PushSubscription;
    const userAgent = req.headers['user-agent'] || '';
    webPush.addOrUpdateSubscription(subscription, userAgent);
    res.json({ success: true });
  }));

  // POST /api/notifications/unregister - Remove a push subscription
  router.post('/unregister', asyncHandler(async (req, res) => {
    await webPush.initialize();
    const { endpoint } = req.body as { endpoint: string };
    if (!endpoint) {
      res.status(400).json({ error: 'Missing endpoint' });
      return;
    }
    webPush.removeSubscriptionByEndpoint(endpoint);
    res.json({ success: true });
  }));

  // POST /api/notifications/test - Send a test notification
  router.post('/test', asyncHandler(async (_req, res) => {
    await webPush.initialize();
    const result = await webPush.broadcast({
      title: 'Lattice Test',
      message: 'Push notifications are working!',
      tag: 'test',
    });
    res.json({ success: true, ...result });
  }));

  return router;
}
