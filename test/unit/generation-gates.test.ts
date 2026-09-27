/**
 * Generation switches: an unset switch comes on only for the cheap features
 * whose keys are saved; an explicit true or false in config always wins.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

let generation: Record<string, boolean> | undefined;
let anthropicKey = false;
let configReady = true;

vi.mock('../../src/services/infrastructure/config-service.js', () => ({
  ConfigService: {
    getInstance: () => ({
      getConfig: () => {
        if (!configReady) throw new Error('not initialised');
        return { generation };
      },
    }),
  },
}));
vi.mock('../../src/services/infrastructure/anthropic-client-factory.js', () => ({
  anthropicClientFactory: { isConfigured: () => anthropicKey },
}));

const { isGenerationEnabled } = await import('../../src/services/infrastructure/generation-gates.js');

beforeEach(() => {
  generation = undefined;
  anthropicKey = false;
  configReady = true;
});

describe('generation switches left unset', () => {
  it('stay off with no keys saved', () => {
    for (const f of ['workerReportSummary', 'workerActivity', 'projectName', 'insights'] as const) {
      expect(isGenerationEnabled(f)).toBe(false);
    }
  });

  it('turn on report summaries, activity lines and project names once an Anthropic key is saved', () => {
    anthropicKey = true;
    expect(isGenerationEnabled('workerReportSummary')).toBe(true);
    expect(isGenerationEnabled('workerActivity')).toBe(true);
    expect(isGenerationEnabled('projectName')).toBe(true);
  });

  it('keep insights and the other background work off even with a key saved', () => {
    anthropicKey = true;
    for (const f of ['insights', 'sessionSummary', 'turnCapture', 'permissionPatterns', 'sessionReview', 'gemini'] as const) {
      expect(isGenerationEnabled(f)).toBe(false);
    }
  });
});

describe('explicit switches', () => {
  it('win over the key-based default in both directions', () => {
    anthropicKey = true;
    generation = { workerActivity: false, insights: true };
    expect(isGenerationEnabled('workerActivity')).toBe(false);
    expect(isGenerationEnabled('insights')).toBe(true);
    expect(isGenerationEnabled('projectName')).toBe(true);

    anthropicKey = false;
    generation = { projectName: true };
    expect(isGenerationEnabled('projectName')).toBe(true);
  });

  it('answer no before config is loaded, keys or not', () => {
    anthropicKey = true;
    configReady = false;
    expect(isGenerationEnabled('workerReportSummary')).toBe(false);
  });
});
