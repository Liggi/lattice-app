import { Router } from 'express';
import { ConfigService } from '@/services/infrastructure/config-service.js';
import { requireTrustedOrigin } from '@/middleware/trusted-origin.js';
import { AUTH_COOKIE, authCookieValue, hasValidAuthCookie, tokensMatch } from '@/middleware/auth-token.js';
import { createLogger } from '@/services/infrastructure/logger.js';

const logger = createLogger('AuthRoutes');
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * The web app's sign-in for a server with `server.authToken` set. The browser
 * cannot put a bearer header on images or EventSource, so it trades the token
 * once for an HttpOnly cookie the auth middleware also accepts.
 */
export function createAuthRoutes(): Router {
  const router = Router();

  // GET /api/auth/status - Whether this browser needs to enter the token
  router.get('/status', (req, res) => {
    const authToken = ConfigService.getInstance().getConfig().server.authToken;
    res.json({
      required: !!authToken,
      authenticated: !authToken || hasValidAuthCookie(req, authToken),
    });
  });

  // POST /api/auth/login - Exchange the token for the sign-in cookie
  router.post('/login', requireTrustedOrigin, (req, res) => {
    const authToken = ConfigService.getInstance().getConfig().server.authToken;
    if (!authToken) {
      res.json({ authenticated: true });
      return;
    }
    const given = (req.body as { token?: unknown } | undefined)?.token;
    if (typeof given !== 'string' || !tokensMatch(given.trim(), authToken)) {
      logger.warn('Web sign-in with wrong token', { ip: req.ip });
      res.status(401).json({ error: 'That token does not match the one this server is configured with.' });
      return;
    }
    res.cookie(AUTH_COOKIE, authCookieValue(authToken), {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure,
      path: '/',
      maxAge: COOKIE_MAX_AGE_MS,
    });
    res.json({ authenticated: true });
  });

  return router;
}
