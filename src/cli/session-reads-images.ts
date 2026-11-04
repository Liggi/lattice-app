import fs from 'fs';
import path from 'path';
import { configDirNow } from '../utils/constants.js';
import { modelReadsImages } from '../constants/claude-endpoint.js';
import { parseJson } from '../utils/json.js';

/**
 * Whether the session running this command can be shown an image. A session
 * on a custom endpoint runs with ANTHROPIC_MODEL set to the endpoint's model,
 * and the endpoint saved in Settings says whether that model reads images;
 * any other session can. Read from the config file so a command run outside
 * the server still answers.
 */
export function sessionReadsImages(model: string | undefined = process.env.ANTHROPIC_MODEL): boolean {
  if (!model) return true;
  let config: unknown = null;
  try {
    config = parseJson(fs.readFileSync(path.join(configDirNow(), 'config.json'), 'utf8'));
  } catch {
    return true;
  }
  return modelReadsImages(config, model);
}
