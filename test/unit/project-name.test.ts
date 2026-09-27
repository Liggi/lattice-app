/**
 * Automatic project naming: a project is titled from the outcome its
 * coordinator agreed, the title survives ordinary progress, and a name the
 * user typed is never displaced by one the server generated.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeProjectName, PROJECT_NAME_MAX_CHARS } from '../../src/services/insights/anthropic-service.js';
import { __setGenerationOverridesForTests } from '../../src/services/infrastructure/generation-gates.js';
import { resolveCardTitle } from '../../src/web/chat/components/shared/session-card-orientation.js';

const messagesCreate = vi.fn();
const updateSessionInfo = vi.fn(async () => ({}));
let storedProjectName: string | null = null;
let isCoordinator = true;

vi.mock('../../src/services/infrastructure/anthropic-client-factory.js', () => ({
  anthropicClientFactory: {
    getClient: () => ({ messages: { create: messagesCreate } }),
    getState: () => ({ configured: true }),
  },
}));
vi.mock('../../src/services/sessions/session-info-service.js', () => ({
  SessionInfoService: {
    getInstance: () => ({
      getSessionInfo: async () => ({ project_name: storedProjectName ?? undefined }),
      updateSessionInfo,
    }),
  },
}));
vi.mock('../../src/services/sessions/conversation-service.js', () => ({
  ConversationService: {
    getInstance: () => ({ getConversation: () => ({ coordinator: isCoordinator }) }),
  },
}));

const {
  backfillProjectName,
  generateProjectName,
  onProjectOutcomeChanged,
  __resetProjectNameGuardsForTests,
} = await import('../../src/services/sessions/project-name.js');

function replies(text: string): void {
  messagesCreate.mockResolvedValue({
    content: [{ type: 'text', text }],
    usage: { input_tokens: 90, output_tokens: 6 },
  });
}

/** Let the fire-and-forget generation settle before asserting on it. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  messagesCreate.mockReset();
  updateSessionInfo.mockClear();
  storedProjectName = null;
  isCoordinator = true;
  __resetProjectNameGuardsForTests();
  __setGenerationOverridesForTests({ projectName: true });
});

afterEach(() => {
  __setGenerationOverridesForTests(null);
});

describe('what counts as a project name', () => {
  it('keeps a noun phrase naming the thing owned', () => {
    expect(normalizeProjectName('Lattice workspace improvements')).toBe('Lattice workspace improvements');
  });

  it('strips quoting and trailing punctuation a model adds around the answer', () => {
    expect(normalizeProjectName('  "Canary reports and QC priorities."  ')).toBe('Canary reports and QC priorities');
  });

  it('rejects a name that leads with a verb, because that names the task and not the project', () => {
    // The exact drifting titles this feature replaces.
    expect(normalizeProjectName('Simplify app UI and clean up sidebar')).toBeNull();
    expect(normalizeProjectName('Turn detector work into a coherent plan')).toBeNull();
    expect(normalizeProjectName('Make canary reports drive release decisions')).toBeNull();
  });

  it('rejects a model that explains itself instead of answering', () => {
    expect(normalizeProjectName(
      'Here is a good name for this project, based on the outcome you provided above: Detector platform'
    )).toBeNull();
  });

  it('never cuts a long name; fitting it is the model\'s job', () => {
    const long = 'Detector platform alignment datasets and automation coverage everywhere';
    expect(long.length).toBeGreaterThan(PROJECT_NAME_MAX_CHARS);
    expect(normalizeProjectName(long)).toBe(long);
  });

  it('has nothing to say about an empty answer', () => {
    expect(normalizeProjectName('   ')).toBeNull();
  });
});

describe('generating and storing a project name', () => {
  it('writes the generated name to its own field, not over the user-facing name', async () => {
    replies('Lattice workspace improvements');
    const name = await generateProjectName('conv-proj', 'Own the ongoing development of Lattice orchestrator and the restyled app');

    expect(name).toBe('Lattice workspace improvements');
    expect(updateSessionInfo).toHaveBeenCalledWith('conv-proj', { project_name: 'Lattice workspace improvements' });
    const [, update] = updateSessionInfo.mock.calls[0] as [string, Record<string, unknown>];
    expect(update).not.toHaveProperty('custom_name');
  });

  it('sends the outcome and nothing from the transcript', async () => {
    replies('Canary reports and QC priorities');
    await generateProjectName('conv-proj', 'Make canary reports useful for release decisions');

    const prompt = messagesCreate.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('Make canary reports useful for release decisions');
    expect(prompt).toContain('outcome');
  });

  it('asks again for a name too long for its line, and stores the second answer whole', async () => {
    messagesCreate
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Detector platform alignment datasets and automation coverage' }], usage: { input_tokens: 90, output_tokens: 9 } })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Detector platform alignment' }], usage: { input_tokens: 120, output_tokens: 5 } });
    const name = await generateProjectName('conv-proj', 'Own detector platform alignment datasets and automation coverage');
    expect(name).toBe('Detector platform alignment');
    const followUp = messagesCreate.mock.calls[1][0].messages[2].content as string;
    expect(followUp).toContain(`has to fit in ${PROJECT_NAME_MAX_CHARS}`);
  });

  it('drops a name that keeps naming something the outcome does not', async () => {
    replies('Lattice Opus 5 migration');
    const name = await generateProjectName('conv-proj', 'Move Lattice onto Opus 5.5');
    expect(messagesCreate).toHaveBeenCalledTimes(2);
    expect(name).toBeNull();
    expect(updateSessionInfo).not.toHaveBeenCalled();
  });

  it('stores nothing when the model returns an unusable name', async () => {
    replies('Simplify the sidebar');
    const name = await generateProjectName('conv-proj', 'Own the ongoing development of Lattice');

    expect(name).toBeNull();
    expect(updateSessionInfo).not.toHaveBeenCalled();
  });

  it('spends nothing while the gate is off', async () => {
    __setGenerationOverridesForTests({ projectName: false });
    const name = await generateProjectName('conv-proj', 'Own the ongoing development of Lattice');

    expect(name).toBeNull();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('survives the model failing, leaving the project with no generated name', async () => {
    messagesCreate.mockRejectedValue(new Error('invalid_request_error'));
    await expect(generateProjectName('conv-proj', 'Own the ongoing development of Lattice')).resolves.toBeNull();
    expect(updateSessionInfo).not.toHaveBeenCalled();
  });
});

describe('when a project is renamed', () => {
  it('regenerates once the agreed outcome actually changes', async () => {
    replies('Detector platform');
    onProjectOutcomeChanged(
      'conv-proj',
      'Turn detector work into a coherent project',
      'Turn detector creation, alignment and automations into one coherent project',
    );
    await settle();

    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(updateSessionInfo).toHaveBeenCalledWith('conv-proj', { project_name: 'Detector platform' });
  });

  it('spends nothing when the same outcome is restated in the same words', async () => {
    replies('Detector platform');
    const outcome = 'Turn detector work into one coherent project';
    onProjectOutcomeChanged('conv-proj', outcome, `  ${outcome}  `);
    await settle();

    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('names a project the first time an outcome is agreed', async () => {
    replies('Detector platform');
    onProjectOutcomeChanged('conv-proj', null, 'Turn detector work into one coherent project');
    await settle();

    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });
});

describe('a second outcome arriving while the first is still generating', () => {
  /** A call whose promise the test resolves by hand. */
  function deferred(): { promise: Promise<unknown>; resolve: (text: string) => void } {
    let release!: (text: string) => void;
    const promise = new Promise<unknown>(resolveOuter => {
      release = (text: string) => resolveOuter({
        content: [{ type: 'text', text }],
        usage: { input_tokens: 90, output_tokens: 6 },
      });
    });
    return { promise, resolve: release };
  }

  it('ends on the newer outcome, and never stores the superseded one', async () => {
    const first = deferred();
    messagesCreate.mockReturnValueOnce(first.promise);

    const a = generateProjectName('conv-proj', 'Own the ongoing development of Lattice orchestrator');
    await settle();

    // B arrives while A is still in the model call.
    replies('Lattice project workspace');
    const b = await generateProjectName('conv-proj', 'Make Lattice a clear, reliable workspace for ongoing projects');
    expect(b).toBeNull(); // handed to the running call rather than dropped

    first.resolve('Lattice orchestrator and restyled app');
    await a;
    await settle();

    // A's result is thrown away rather than written, so the only name ever
    // stored is the one for the outcome that actually stands.
    const stored = updateSessionInfo.mock.calls.map(call => (call as [string, { project_name: string }])[1].project_name);
    expect(stored).toEqual(['Lattice project workspace']);
    expect(messagesCreate).toHaveBeenCalledTimes(2);
  });

  it('leaves the field empty when the newer outcome fails, so backfill retries', async () => {
    const first = deferred();
    messagesCreate.mockReturnValueOnce(first.promise);

    const a = generateProjectName('conv-proj', 'Own the ongoing development of Lattice orchestrator');
    await settle();

    // The newer outcome's call fails outright.
    messagesCreate.mockRejectedValueOnce(new Error('invalid_request_error'));
    await generateProjectName('conv-proj', 'Make Lattice a clear, reliable workspace for ongoing projects');

    first.resolve('Lattice orchestrator and restyled app');
    await a;
    await settle();

    // The superseded name must not be what the project is left holding.
    expect(updateSessionInfo).not.toHaveBeenCalled();

    // And with nothing stored, the next backfill is free to try again.
    replies('Lattice project workspace');
    await backfillProjectName('conv-proj', 'Make Lattice a clear, reliable workspace for ongoing projects');
    expect(updateSessionInfo).toHaveBeenCalledWith('conv-proj', { project_name: 'Lattice project workspace' });
  });
});

describe('a name the coordinator gives with its outcome', () => {
  it('is stored as the project name, with no model call and no API key needed', async () => {
    __setGenerationOverridesForTests({ projectName: false });
    onProjectOutcomeChanged('conv-proj', null, 'Own the ongoing development of Lattice', 'Lattice workspace improvements');
    await settle();

    expect(messagesCreate).not.toHaveBeenCalled();
    expect(updateSessionInfo).toHaveBeenCalledWith('conv-proj', { project_name: 'Lattice workspace improvements' });
  });

  it('is not replaced when the same outcome is restated with a different name', async () => {
    storedProjectName = 'Lattice workspace improvements';
    const outcome = 'Own the ongoing development of Lattice';
    onProjectOutcomeChanged('conv-proj', outcome, outcome, 'Lattice orchestrator');
    await settle();

    expect(updateSessionInfo).not.toHaveBeenCalled();
  });

  it('names a project that has an outcome but no name yet when the outcome is restated', async () => {
    const outcome = 'Own the ongoing development of Lattice';
    onProjectOutcomeChanged('conv-proj', outcome, outcome, 'Lattice workspace improvements');
    await settle();

    expect(updateSessionInfo).toHaveBeenCalledWith('conv-proj', { project_name: 'Lattice workspace improvements' });
  });

  it('falls back to generation when the name is a task rather than a project', async () => {
    replies('Lattice workspace');
    onProjectOutcomeChanged('conv-proj', null, 'Own the ongoing development of Lattice', 'Simplify the sidebar');
    await settle();

    expect(updateSessionInfo).toHaveBeenCalledWith('conv-proj', { project_name: 'Lattice workspace' });
  });

  it('is not overwritten by a generation that was already running', async () => {
    let release!: (text: string) => void;
    messagesCreate.mockReturnValueOnce(new Promise(resolve => {
      release = (text: string) => resolve({ content: [{ type: 'text', text }], usage: { input_tokens: 90, output_tokens: 6 } });
    }));
    const running = generateProjectName('conv-proj', 'Own the ongoing development of Lattice');
    await settle();

    onProjectOutcomeChanged('conv-proj', 'Own the ongoing development of Lattice', 'Make Lattice ready for other people', 'Lattice open-source release');
    await settle();
    release('Lattice orchestrator');
    await running;

    const stored = updateSessionInfo.mock.calls.map(call => (call as [string, { project_name: string }])[1].project_name);
    expect(stored).toEqual(['Lattice open-source release']);
  });
});

describe('naming a project that has none yet', () => {
  it('names a project that predates the feature', async () => {
    replies('Lattice workspace improvements');
    await backfillProjectName('conv-proj', 'Own the ongoing development of Lattice orchestrator');

    expect(updateSessionInfo).toHaveBeenCalledWith('conv-proj', { project_name: 'Lattice workspace improvements' });
  });

  it('leaves an existing name alone, however often the panel asks', async () => {
    storedProjectName = 'Lattice workspace improvements';
    await backfillProjectName('conv-proj', 'Own the ongoing development of Lattice orchestrator');
    await backfillProjectName('conv-proj', 'Own the ongoing development of Lattice orchestrator');

    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('does not name a project that has agreed no outcome', async () => {
    await backfillProjectName('conv-proj', null);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('does not name an ordinary session', async () => {
    isCoordinator = false;
    await backfillProjectName('conv-session', 'Own the ongoing development of Lattice orchestrator');
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('runs one generation at a time, however many refetches arrive', async () => {
    replies('Lattice workspace improvements');
    await Promise.all([
      backfillProjectName('conv-proj', 'Own the ongoing development of Lattice orchestrator'),
      backfillProjectName('conv-proj', 'Own the ongoing development of Lattice orchestrator'),
      backfillProjectName('conv-proj', 'Own the ongoing development of Lattice orchestrator'),
    ]);

    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });
});

describe('the title a card renders', () => {
  const conversationId = 'conv-card-title';

  it('shows the project name rather than whatever task the transcript is on', () => {
    expect(resolveCardTitle({
      projectName: 'Lattice workspace improvements',
      description: { text: 'Simplify app UI and clean up sidebar/header', source: 'insights' },
      conversationId,
    })).toBe('Lattice workspace improvements');
  });

  it('keeps the name the user typed, even against a newly generated one', () => {
    expect(resolveCardTitle({
      customName: 'Lattice',
      projectName: 'Lattice workspace improvements',
      description: { text: 'Simplify app UI and clean up sidebar/header', source: 'insights' },
      conversationId,
    })).toBe('Lattice');
  });

  it('leaves an ordinary session on its transcript description', () => {
    expect(resolveCardTitle({
      description: { text: 'Restore the worker serving port 3045', source: 'ambient' },
      conversationId,
    })).toBe('Restore the worker serving port 3045');
  });

  it('falls back to the transcript when a project has no generated name', () => {
    expect(resolveCardTitle({
      projectName: null,
      description: { text: 'Simplify app UI and clean up sidebar/header', source: 'insights' },
      conversationId,
    })).toBe('Simplify app UI and clean up sidebar/header');
  });

  it('shows the id when a project has nothing else yet', () => {
    expect(resolveCardTitle({ conversationId })).toBe('conv-car');
  });
});
