import fs from 'fs';
import path from 'path';
import { CONFIG_DIR } from '../utils/constants.js';
import { parseJson } from '../utils/json.js';

/**
 * The Authorization header for the local server, from `server.authToken` in
 * the config.json the server loads. Empty when no token is set, which is
 * when the server does not check one.
 */
export function serverAuthHeaders(): Record<string, string> {
  try {
    const raw = fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf-8');
    const token = (parseJson(raw) as { server?: { authToken?: string } }).server?.authToken;
    return token ? { authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}
