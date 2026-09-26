import type { GenerationConfig } from '@/types/config.js';
import { ConfigService } from './config-service.js';
import { createLogger } from './logger.js';
import { CONFIG_FILE } from '@/utils/constants.js';

const logger = createLogger('GenerationGates');

/**
 * One place to ask "should this background generator run?".
 *
 * These generators bill a real API key on their own schedule, so the failure
 * mode is silent spend rather than a broken screen. Two consequences shape
 * this module:
 *
 * 1. **Closed by default.** An unreadable or uninitialised config answers
 *    "no", never "yes". A gate that fails open is not a gate.
 * 2. **Read per call.** ConfigService watches config.json and reloads on
 *    change, so flipping a switch takes effect on the next tick with no
 *    restart — which matters when the thing you are turning off is spending
 *    money right now.
 */
export type GenerationFeature = keyof GenerationConfig;

/** Names for logs; the config key alone reads as jargon in a log line. */
const DESCRIPTIONS: Record<GenerationFeature, string> = {
  sessionSummary: 'session summaries',
  insights: 'session insights',
  turnCapture: 'turn capture',
  permissionPatterns: 'permission pattern suggestions',
  sessionReview: 'session reviews',
  gemini: 'Gemini calls',
  voice: 'voice mode',
  coordinatorFastReply: 'coordinator routing and fast replies',
  workerActivity: 'worker activity lines',
  workerReportSummary: 'worker report summaries',
  projectName: 'project names',
};

/**
 * Test seam. Unit tests drive the generators directly with fake model clients
 * and no initialised ConfigService, so without this every one of them would
 * assert against a closed gate. Set what the suite needs, reset in afterEach.
 */
let testOverrides: Partial<Record<GenerationFeature, boolean>> | null = null;

export function __setGenerationOverridesForTests(
  overrides: Partial<Record<GenerationFeature, boolean>> | null,
): void {
  testOverrides = overrides;
}

export function isGenerationEnabled(feature: GenerationFeature): boolean {
  if (testOverrides && feature in testOverrides) {
    return testOverrides[feature] === true;
  }
  try {
    return ConfigService.getInstance().getConfig().generation?.[feature] === true;
  } catch {
    // getConfig() throws before initialize(). Boot-time ticks land here.
    return false;
  }
}

/**
 * Gate plus a debug line naming what was skipped and how to turn it back on.
 * Returns true when the caller should proceed.
 */
export function allowGeneration(feature: GenerationFeature): boolean {
  if (isGenerationEnabled(feature)) return true;
  logger.debug(`Skipping ${DESCRIPTIONS[feature]} — generation.${feature} is off`, {
    feature,
    enableWith: `set generation.${feature} to true in ${CONFIG_FILE}`,
  });
  return false;
}
