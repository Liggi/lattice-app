/**
 * Keys a plugin may read (`host.keys.get`): ones the user saved with
 * `lattice keys import` or in Settings for a plugin to use. Read from the
 * config on each call, so a key saved while Lattice runs is used at once.
 */

import type { LatticeKeyName } from '@liggi/lattice-plugin-kit';
import { ConfigService } from '@/services/infrastructure/config-service.js';

export function savedKey(name: LatticeKeyName): string | null {
  if (name !== 'slack') return null;
  const key = ConfigService.getInstance().getConfig().slack?.apiKey?.trim();
  return key ? key : null;
}
