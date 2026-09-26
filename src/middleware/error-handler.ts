import { Request, Response, NextFunction, RequestHandler } from 'express';
import { LatticeError } from '@/types/index.js';
import { createLogger } from '@/services/infrastructure/logger.js';
import { RequestWithRequestId } from '@/types/express.js';

const logger = createLogger('ErrorHandler');

/**
 * Wraps an async Express route handler to properly forward errors to the error middleware.
 * Without this wrapper, async route handlers that throw will cause unhandled promise rejections.
 *
 * Usage:
 *   router.get('/path', asyncHandler(async (req, res) => { ... }));
 *
 * Accepts any Request type (with generics for params, body, query) that extends RequestWithRequestId.
 */
export function asyncHandler<
  P = Record<string, string>,
  ResBody = unknown,
  ReqBody = unknown,
  ReqQuery = Record<string, string | undefined>
>(
  fn: (req: Request<P, ResBody, ReqBody, ReqQuery> & RequestWithRequestId, res: Response<ResBody>, next: NextFunction) => Promise<void>
): RequestHandler<P, ResBody, ReqBody, ReqQuery> {
  return (req, res, next) => {
    Promise.resolve(fn(req as Request<P, ResBody, ReqBody, ReqQuery> & RequestWithRequestId, res, next)).catch(next);
  };
}

export function errorHandler(err: Error, req: RequestWithRequestId, res: Response, _next: NextFunction): void {
  const requestId = req.requestId || 'unknown';
  
  if (err instanceof LatticeError) {
    const logFn = err.statusCode >= 500 ? logger.error.bind(logger) : logger.debug.bind(logger);
    logFn('LatticeError in request', {
      requestId,
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
      url: req.url,
      method: req.method
    });
    res.status(err.statusCode).json({ error: err.message, code: err.code });
  } else {
    logger.error('Unhandled error', err, {
      requestId,
      url: req.url,
      method: req.method,
      errorType: err.constructor.name
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}