import { Request } from 'express';

/**
 * Typed Express request with requestId middleware property.
 *
 * For type-safe route handlers, specify TBody:
 *   RequestWithRequestId<{ toolName: string; toolInput?: unknown }>
 *
 * For handlers that don't access req.body, omit type params (defaults to unknown).
 */
export interface RequestWithRequestId<
  TBody = unknown,
  TQuery = Record<string, string | undefined>,
  TParams = Record<string, string>
> extends Request<TParams, unknown, TBody, TQuery> {
  requestId?: string;
}