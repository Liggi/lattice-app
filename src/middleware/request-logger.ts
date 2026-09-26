import { Response, NextFunction } from 'express';
import { RequestWithRequestId } from '@/types/express.js';

export function requestLogger(req: RequestWithRequestId, res: Response, next: NextFunction): void {
  const requestId = Math.random().toString(36).substring(7);
  req.requestId = requestId;
  next();
}
