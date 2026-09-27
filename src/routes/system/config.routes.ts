import { Router, Request } from 'express';
import fs from 'fs';
import { ConfigService } from '@/services/infrastructure/config-service.js';
import type { LatticeConfig } from '@/types/config.js';
import { asyncHandler } from '@/middleware/error-handler.js';
import { requireTrustedOrigin } from '@/middleware/trusted-origin.js';
import { AMBIENT_LATEST_PATH } from '@/routes/ambient.routes.js';

/** Keys the browser may set but never read back. */
const SECRET_FIELDS = [
  ['anthropic', 'apiKey'],
  ['gemini', 'apiKey'],
] as const;

/**
 * What the browser gets: the config with every secret replaced by whether it
 * is set. The settings screen shows "Key saved" and offers Replace or Remove;
 * the value itself stays on this machine.
 */
export function publicConfig(config: LatticeConfig): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...config };
  for (const [section, field] of SECRET_FIELDS) {
    const current = copy[section];
    if (!current || typeof current !== 'object') continue;
    const { [field]: value, ...rest } = current as Record<string, unknown>;
    copy[section] = { ...rest, [`${field}Configured`]: typeof value === 'string' && value.trim().length > 0 };
  }
  const server = { ...(copy.server as Record<string, unknown>) };
  delete server.authToken;
  copy.server = server;
  return copy;
}

/**
 * A secret in an update means: a string replaces it, `null` removes it, and
 * leaving it out keeps what is saved. The old form re-submitted the value it
 * had read back; now that nothing is read back, an omitted key must not clear
 * the one on disk.
 */
export function normalizeSecretUpdates(updates: Partial<LatticeConfig>, current: LatticeConfig): Partial<LatticeConfig> {
  const next: Record<string, unknown> = { ...updates };
  for (const [section, field] of SECRET_FIELDS) {
    const submitted = next[section];
    if (!submitted || typeof submitted !== 'object') continue;
    const sectionUpdate = { ...(submitted as Record<string, unknown>) };
    delete sectionUpdate[`${field}Configured`];
    const value = sectionUpdate[field];
    if (value === null) {
      sectionUpdate[field] = undefined;
    } else if (typeof value === 'string') {
      const trimmed = value.trim();
      sectionUpdate[field] = trimmed.length > 0 ? trimmed : undefined;
    } else {
      const saved = (current as unknown as Record<string, Record<string, unknown> | undefined>)[section]?.[field];
      if (saved !== undefined) sectionUpdate[field] = saved;
      else delete sectionUpdate[field];
    }
    next[section] = sectionUpdate;
  }
  if (next.server && typeof next.server === 'object') {
    // The bearer token is set in the config file by hand, never from the page.
    const { authToken: _ignored, ...server } = next.server as Record<string, unknown>;
    next.server = server;
  }
  return next as Partial<LatticeConfig>;
}

/**
 * The config plus what this machine has right now. `ambientScan` says whether
 * an ambient watcher has written a scan, so the UI does not poll for a file a
 * fresh install never has.
 */
function configResponse(service: ConfigService): Record<string, unknown> {
  const config = publicConfig(service.getConfig());
  return { ...config, server: { ...(config.server as Record<string, unknown>), ambientScan: fs.existsSync(AMBIENT_LATEST_PATH) } };
}

export function createConfigRoutes(service: ConfigService): Router {
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    res.json(configResponse(service));
  }));

  // Writes keys, so only the Lattice page itself may call it.
  router.put('/', requireTrustedOrigin, asyncHandler(async (req: Request<Record<string, never>, unknown, Partial<LatticeConfig>>, res) => {
    await service.updateConfig(normalizeSecretUpdates(req.body ?? {}, service.getConfig()));
    res.json(configResponse(service));
  }));

  // Tailscale can start after the server does, so the Access tab asks again.
  router.get('/tailscale', asyncHandler(async (req, res) => {
    res.json(await service.detectTailscale());
  }));

  return router;
}
