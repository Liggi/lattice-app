/**
 * The server's one ShippingWatcher: the project panel's shipping route reads
 * and refreshes through it, and the Inbox reads its cached snapshots without
 * waiting on git or gh.
 */

import path from 'node:path';
import { CONFIG_DIR } from '../../utils/constants.js';
import { ShippingWatcher } from './project-shipping.js';
import { readProjectState } from './project-state.js';

let shared: ShippingWatcher | null = null;

export function shippingWatch(): ShippingWatcher {
  shared ??= new ShippingWatcher(path.join(CONFIG_DIR, 'project-shipping.json'), readProjectState);
  return shared;
}
