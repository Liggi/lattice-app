import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';
import {
  buildPinnedCharacterPrompt,
  choosePinnedCharacterName,
} from '../../src/services/sessions/pinned-character-service.js';

describe('pinned session characters', () => {
  beforeEach(() => {
    ConversationService.resetInstance();
    DatabaseProvider.resetInstance();
  });

  afterEach(() => {
    ConversationService.resetInstance();
    DatabaseProvider.resetInstance();
  });

  it('chooses a stable non-colliding name for a conversation', () => {
    const first = choosePinnedCharacterName('conv-character-a', []);
    expect(choosePinnedCharacterName('conv-character-a', [])).toBe(first);

    const next = choosePinnedCharacterName('conv-character-a', [first]);
    expect(next).not.toBe(first);
    expect(next).toMatch(/^[A-Z][a-z]+(?: \d+)?$/);
  });

  it('keeps work context thematic while asking for a close person-like portrait', () => {
    const prompt = buildPinnedCharacterPrompt('Mara', {
      mission: 'Trace a difficult event ordering bug',
      project: 'Lattice',
      theme: 'investigating',
    });

    expect(prompt).toContain('named character called Mara');
    expect(prompt).toContain('Trace a difficult event ordering bug');
    expect(prompt).toContain('Do not literally depict software');
    expect(prompt).toContain('not a creature or topic mascot');
    expect(prompt).toContain('no animal, monster, robot');
    expect(prompt).toContain('one close head-and-shoulders portrait');
    expect(prompt).toContain('no decorative frame, border');
    expect(prompt).toContain('no text, letters');
  });

  it('persists one identity through unpin and re-pin', async () => {
    const sessionInfo = new SessionInfoService(':memory:');
    await sessionInfo.initialize();
    await sessionInfo.updateSessionInfo('conv-persistent-character', { archived: false });

    const firstPin = await sessionInfo.attachPinnedCharacterAndPin(
      'conv-persistent-character',
      { name: 'Mara', imageData: 'first-image' },
    );
    expect(firstPin).toMatchObject({
      pinned: true,
      pin_character_name: 'Mara',
      pin_character_image: 'first-image',
    });

    const unpinned = await sessionInfo.updateSessionInfo('conv-persistent-character', { pinned: false });
    expect(unpinned).toMatchObject({
      pinned: false,
      pin_character_name: 'Mara',
      pin_character_image: 'first-image',
    });

    const rePinned = await sessionInfo.attachPinnedCharacterAndPin(
      'conv-persistent-character',
      { name: 'Replacement', imageData: 'replacement-image' },
    );
    expect(rePinned).toMatchObject({
      pinned: true,
      pin_character_name: 'Mara',
      pin_character_image: 'first-image',
    });
  });
});
