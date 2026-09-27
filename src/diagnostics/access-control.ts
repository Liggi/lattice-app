/**
 * Diagnostics access control (§1.2).
 *
 * Diagnostics expose paths, process args, prompts, message content, and other
 * sensitive runtime data. Default-closed in production and in any built or
 * installed server; loopback-open for a source checkout run in
 * development/test, for local triage.
 */

import type { Request } from 'express';
import { runsFromSource } from '../server/vite-dev-client.js';

function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    ip.startsWith('127.')
  );
}

interface MaybeAdminRequest extends Request {
  user?: { isAdmin?: boolean };
}

function isLocalDevOrTest(): boolean {
  const env = process.env.NODE_ENV;
  return runsFromSource && (env === 'development' || env === 'test');
}

export function mayReadDiagnostics(req: Request): boolean {
  if (isLocalDevOrTest() && isLoopback(req.ip)) return true;

  if (process.env.LATTICE_DIAGNOSTICS_ENABLED !== 'true') return false;

  return Boolean((req as MaybeAdminRequest).user?.isAdmin);
}

export function mayReadRawDiagnostics(req: Request): boolean {
  if (!mayReadDiagnostics(req)) return false;

  if (isLocalDevOrTest() && isLoopback(req.ip)) return true;

  return (
    process.env.LATTICE_DIAGNOSTICS_RAW_ENABLED === 'true' &&
    Boolean((req as MaybeAdminRequest).user?.isAdmin)
  );
}

export function describeAccessMode(req: Request): 'development-loopback' | 'admin' {
  if (isLocalDevOrTest() && isLoopback(req.ip)) return 'development-loopback';
  return 'admin';
}
