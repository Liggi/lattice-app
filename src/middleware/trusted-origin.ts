import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '../services/infrastructure/logger.js';

const logger = createLogger('TrustedOrigin');

/**
 * Whether a request came from a page this server itself served.
 *
 * Browsers say so in two places: `Sec-Fetch-Site` on every modern browser,
 * and `Origin` on any request that could change something. A request carrying
 * neither is not from a browser page (curl, the lattice CLI) and is left to
 * the bearer-token middleware, which is the only guard such callers have.
 */
export function isTrustedOrigin(headers: Request['headers']): { trusted: boolean; reason?: string } {
  const fetchSite = headers['sec-fetch-site'];
  if (typeof fetchSite === 'string') {
    if (fetchSite === 'same-origin' || fetchSite === 'none') return { trusted: true };
    return { trusted: false, reason: `sec-fetch-site: ${fetchSite}` };
  }
  const origin = headers.origin;
  if (typeof origin !== 'string') return { trusted: true };
  const host = headers.host;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return { trusted: false, reason: 'unparseable origin' };
  }
  if (host && originHost === host) return { trusted: true };
  return { trusted: false, reason: `origin ${originHost} is not ${host ?? 'this host'}` };
}

/**
 * Refuses browser requests from any other site. The global CORS middleware
 * reflects every origin, which is fine for reading a status but not for the
 * routes that type into a sign-in terminal or store a key; those mount this
 * in front so a page on another site cannot drive them with the user's
 * cookies and network position.
 */
export function requireTrustedOrigin(req: Request, res: Response, next: NextFunction): void {
  const verdict = isTrustedOrigin(req.headers);
  if (verdict.trusted) {
    next();
    return;
  }
  logger.warn('Refused cross-site request', { path: req.path, reason: verdict.reason });
  res.status(403).json({ error: 'This action is only available from the Lattice page itself', code: 'CROSS_ORIGIN_REFUSED' });
}
