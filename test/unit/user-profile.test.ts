import { describe, expect, it, vi } from 'vitest';
import type { UserConfig } from '../../src/types/config.js';

const config: { user?: UserConfig } = {};
vi.mock('../../src/services/infrastructure/config-service.js', () => ({
  ConfigService: { getInstance: () => ({ getConfig: () => config }) },
}));

const { buildCoordinatorPreamble, buildWorkerPreamble } = await import('../../src/services/sessions/pickup-prompts.js');

const coordinator = () => buildCoordinatorPreamble({ conversationId: 'conv-c', workingDirectory: '/w', cli: 'lattice' });
const worker = () =>
  buildWorkerPreamble({
    conversationId: 'conv-w',
    parentConversationId: 'conv-c',
    parentProvider: 'codex',
    parentModel: null,
    workingDirectory: '/w',
    cli: 'lattice',
  });

describe('user settings in agent instructions', () => {
  it('calls the user "the user" when no name is set', () => {
    delete config.user;
    expect(coordinator()).toContain('the conversation the user talks to about the work');
    expect(worker()).toContain("shows only the user's messages");
  });

  it("gives a worker the standing rules with none of the user's own guidance set", () => {
    delete config.user;
    expect(worker()).toContain('do not commit, push, deploy or publish unless the user or front has said you may');
    expect(worker()).toContain('Before you say something works, run it');
    expect(worker()).toContain('give each one a time limit');
  });

  it('uses the configured name and appends each role its own guidance', () => {
    config.user = { name: 'Sam', coordinatorGuidance: 'Coordinator rule.', workerGuidance: 'Worker rule.' };
    expect(coordinator()).toContain('the conversation Sam talks to about the work');
    expect(coordinator()).toContain('Coordinator rule.');
    expect(coordinator()).not.toContain('Worker rule.');
    expect(worker()).toContain("shows only Sam's messages");
    expect(worker()).toContain('Worker rule.');
  });
});
