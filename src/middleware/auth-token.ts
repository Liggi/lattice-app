import type { Request, Response, NextFunction } from 'express';
import { ConfigService } from '../services/infrastructure/config-service.js';
import { createLogger } from '../services/infrastructure/logger.js';

const logger = createLogger('AuthMiddleware');

/**
 * Bearer token authentication middleware.
 *
 * Opt-in: only active when `server.authToken` is set in config.
 * When active, all /api/* requests must include:
 *   Authorization: Bearer <token>
 *
 * Excluded paths (always public):
 *   /health, /api/system/health — monitoring
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

    // Exempt paths: health checks and non-API routes (static assets, frontend)
    const path = req.path;
    if (
      path === '/health' ||
      path === '/api/system/health' ||
      !path.startsWith('/api/')
    ) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) {
      logger.warn('Request missing Authorization header', { path, ip: req.ip });
      res.status(401).json({ error: 'Authorization required' });
      return;
    }

    const [scheme, token] = authHeader.split(' ', 2);
    if (scheme !== 'Bearer' || token !== authToken) {
      logger.warn('Invalid auth token', { path, ip: req.ip });
      res.status(403).json({ error: 'Invalid token' });
      return;
    }

    next();
  };
}
