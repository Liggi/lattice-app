/**
 * getSessionInfoBatch replaces the two getSessionInfoSync point queries the
 * conversation list route ran per row. The rows it returns have to be
 * indistinguishable from the ones getSessionInfoSync returned, or the list
 * response shape changes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';

describe('SessionInfoService.getSessionInfoBatch', () => {
  let service: SessionInfoService;

  beforeEach(async () => {
    ConversationService.resetInstance();
    DatabaseProvider.resetInstance();
    service = new SessionInfoService(':memory:');
    await service.initialize();

    await service.updateSessionInfo('conv-one', {
      archived: false,
      custom_name: 'First',
      team_name: 'alpha',
      permission_mode: 'acceptEdits',
    });
    await service.setIdentityImage('conv-one', 'data:image/png;base64,AAAA');

    await service.updateSessionInfo('session-uuid-1', {
      archived: false,
      custom_name: 'Segment',
      conversation_id: 'conv-one',
    });
    await service.setIdentityImage('session-uuid-1', 'data:image/png;base64,BBBB');

    await service.updateSessionInfo('conv-two', { archived: true, pinned: true });
  });

  afterEach(() => {
    ConversationService.resetInstance();
    DatabaseProvider.resetInstance();
  });

  it('returns exactly what getSessionInfoSync returns for each id', () => {
    const batch = service.getSessionInfoBatch(['conv-one', 'session-uuid-1', 'conv-two']);

    expect(batch.size).toBe(3);
    for (const id of ['conv-one', 'session-uuid-1', 'conv-two']) {
      expect(batch.get(id)).toEqual(service.getSessionInfoSync(id));
    }
  });

  it('omits ids that have no row rather than inventing one', () => {
    const batch = service.getSessionInfoBatch(['conv-one', 'conv-does-not-exist']);

    expect(batch.has('conv-one')).toBe(true);
    expect(batch.has('conv-does-not-exist')).toBe(false);
    // getSessionInfoSync is documented as side-effect free; batch must match.
    expect(service.getSessionInfoSync('conv-does-not-exist')).toBeNull();
  });

  it('drops the identity_image column when the caller does not need it', () => {
    const withImages = service.getSessionInfoBatch(['conv-one', 'session-uuid-1']);
    expect(withImages.get('conv-one')?.identity_image).toBe('data:image/png;base64,AAAA');
    expect(withImages.get('session-uuid-1')?.identity_image).toBe('data:image/png;base64,BBBB');

    const withoutImages = service.getSessionInfoBatch(['conv-one', 'session-uuid-1'], {
      includeIdentityImage: false,
    });
    expect(withoutImages.size).toBe(2);
    expect(withoutImages.get('conv-one')?.identity_image).toBeUndefined();
    expect(withoutImages.get('session-uuid-1')?.identity_image).toBeUndefined();

    // Everything else still arrives.
    expect(withoutImages.get('conv-one')).toMatchObject({
      custom_name: 'First',
      team_name: 'alpha',
      permission_mode: 'acceptEdits',
      archived: false,
    });
  });

  it('handles duplicate and empty inputs', () => {
    expect(service.getSessionInfoBatch([]).size).toBe(0);
    expect(service.getSessionInfoBatch(['', 'conv-one']).size).toBe(1);

    const duped = service.getSessionInfoBatch(['conv-one', 'conv-one', 'conv-one']);
    expect(duped.size).toBe(1);
    expect(duped.get('conv-one')?.custom_name).toBe('First');
  });

  it('reuses one prepared statement across repeated same-shape lookups', () => {
    const first = service.getSessionInfoBatch(['conv-one', 'conv-two']);
    const second = service.getSessionInfoBatch(['conv-one', 'conv-two']);
    const third = service.getSessionInfoBatch(['conv-two', 'conv-one']);

    expect(first).toEqual(second);
    expect(third.size).toBe(2);

    const cache = (service as unknown as { batchLookupStmts: Map<string, unknown> }).batchLookupStmts;
    expect(cache.size).toBe(1);
    expect([...cache.keys()]).toEqual(['full:2']);
  });
});
