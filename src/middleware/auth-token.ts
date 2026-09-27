import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { ConfigService } from '../services/infrastructure/config-service.js';
import { createLogger } from '../services/infrastructure/logger.js';
import { isTrustedOrigin } from './trusted-origin.js';

const logger = createLogger('AuthMiddleware');

export const AUTH_COOKIE = 'lattice_auth';

/**
 * The value a signed-in browser holds: derived from the token, so the cookie
 * never carries the bearer token itself and changing the token signs every
 * browser out.
 */
export function authCookieValue(token: string): string {
  return createHmac('sha256', token).update('lattice-web-session').digest('hex');
}

export function tokensMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * Whether this browser request carries the sign-in cookie. Counted only for
 * requests from a page this server served: CORS reflects every origin with
 * credentials, and SameSite still lets a page on another port of the same
 * host send the cookie.
 */
export function hasValidAuthCookie(req: Request, authToken: string): boolean {
  const cookie = readCookie(req, AUTH_COOKIE);
  if (!cookie || !tokensMatch(cookie, authCookieValue(authToken))) return false;
  return isTrustedOrigin(req.headers).trusted;
}

/**
 * Token authentication middleware.
 *
 * Opt-in: only active when `server.authToken` is set in config.
 * When active, all /api/* requests must carry either
 *   Authorization: Bearer <token>   (CLI, hooks, scripts), or
 *   the cookie set by POST /api/auth/login   (the web app).
 *
 * Excluded paths (always public):
 *   /health, /api/system/health — monitoring
 *   /api/auth/* — the web app's sign-in
 *   Static assets (no /api prefix)
 */
export function createAuthMiddleware(): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const config = ConfigService.getInstance().getConfig();
    const authToken = config.server.authToken;

    // No token configured — skip auth entirely (local usage)
    if (!authToken) {
      next();
      return;
    }

    // Exempt paths: health checks, sign-in, and non-API routes (static assets, frontend)
    const path = req.path;
    if (
      path === '/health' ||
      path === '/api/system/health' ||
      path.startsWith('/api/auth/') ||
      !path.startsWith('/api/')
    ) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) {
      if (hasValidAuthCookie(req, authToken)) {
        next();
        return;
      }
      logger.warn('Request missing Authorization header', { path, ip: req.ip });
      res.status(401).json({ error: 'Authorization required' });
      return;
    }

    const [scheme, token] = authHeader.split(' ', 2);
    if (scheme !== 'Bearer' || !token || !tokensMatch(token, authToken)) {
      logger.warn('Invalid auth token', { path, ip: req.ip });
      res.status(403).json({ error: 'Invalid token' });
      return;
    }

    next();
  };
}
