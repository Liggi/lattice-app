import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { PendingQuestionService } from '../../src/services/pending-question-service.js';

const QUESTION = [{
  question: 'Continue?',
  options: [{ label: 'Yes' }],
  multiSelect: false,
}];

afterEach(() => {
  DatabaseProvider.resetInstance();
});

describe('pending question restart semantics', () => {
  it('expires live Codex and Claude requests on boot but keeps rows no live request backs', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-pending-questions-'));
    try {
      const beforeRestart = new PendingQuestionService(configDir);
      await beforeRestart.initialize();
      beforeRestart.addQuestion('codex-question-live', 'conv-codex', 'codex-thread', 'tool-1', QUESTION);
      beforeRestart.addQuestion('claude-question-live', 'conv-claude', 'claude-stream', 'tool-2', QUESTION);
      beforeRestart.addQuestion('legacy-question', 'conv-claude', 'claude-stream', 'tool-3', QUESTION);
      beforeRestart.stopCleanup();
      DatabaseProvider.resetInstance();

      const afterRestart = new PendingQuestionService(configDir);
      await afterRestart.initialize();

      expect(afterRestart.getQuestion('codex-question-live')?.status).toBe('expired');
      expect(afterRestart.getQuestion('claude-question-live')?.status).toBe('expired');
      expect(afterRestart.getQuestion('legacy-question')?.status).toBe('pending');
      afterRestart.stopCleanup();
    } finally {
      DatabaseProvider.resetInstance();
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});
