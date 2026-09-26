/**
 * GET /api/conv used to call getSessionInfoSync twice per row inside .map(),
 * so a 50-conversation page ran 100 synchronous point queries and each one
 * materialized the row's base64 identity_image before the route consulted
 * includeIdentityImage. It now does one batched lookup with a projection that
 * drops the blob when the client did not ask for it.
 *
 * These tests drive the real Express route to pin the response shape, which
 * is what the sidebar reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { Router } from 'express';
import request from 'supertest';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';
import { registerUnifiedConversationQueryRoutes } from '../../src/routes/conversation/unified-conversation.query-routes.js';
import type { UnifiedConversationQueryRoutesContext } from '../../src/routes/conversation/unified-conversation.query-routes.js';

const IMAGE = 'data:image/png;base64,IDENTITY';
const SEGMENT_IMAGE = 'data:image/png;base64,SEGMENT';

interface ListedConversation {
  conversationId: string;
  identityImage: string | null;
  teamName: string | null;
  customName: string;
  pinned: boolean;
  archived: boolean;
  pinCharacterImage: string | null;
  permissionMode: string | null;
}

describe('GET /api/conv session-info batching', () => {
  let sessionInfo: SessionInfoService;
  let app: express.Express;
  let backfillMissing: ReturnType<typeof vi.fn>;
  let conversationIds: { plain: string; pinned: string };

  beforeEach(async () => {
    ConversationService.resetInstance();
    DatabaseProvider.resetInstance();

    sessionInfo = new SessionInfoService(':memory:');
    await sessionInfo.initialize();
    const conversations = ConversationService.getInstance();

    const plain = conversations.createConversation({
      provider: 'claude',
      providerSessionId: 'provider-plain',
      workingDirectory: '/tmp/plain',
    });
    const pinned = conversations.createConversation({
      provider: 'claude',
      providerSessionId: 'provider-pinned',
      workingDirectory: '/tmp/pinned',
    });
    conversationIds = { plain: plain.conversationId, pinned: pinned.conversationId };

    // Conversation-level row carries the identity image and permission mode.
    await sessionInfo.updateSessionInfo(plain.conversationId, {
      archived: false,
      custom_name: 'Plain conversation',
      permission_mode: 'acceptEdits',
    });
    await sessionInfo.setIdentityImage(plain.conversationId, IMAGE);

    // Segment-level row carries team_name — exercises the fallback merge.
    await sessionInfo.updateSessionInfo('provider-plain', {
      archived: false,
      team_name: 'alpha',
      team_role: 'lead',
    });
    await sessionInfo.setIdentityImage('provider-plain', SEGMENT_IMAGE);

    await sessionInfo.updateSessionInfo(pinned.conversationId, { archived: false });
    await sessionInfo.attachPinnedCharacterAndPin(pinned.conversationId, {
      name: 'Mara',
      imageData: 'character-portrait',
    });

    backfillMissing = vi.fn(async () => {});

    const router = Router();
    const context = {
      conversationService: conversations,
      sessionInfoService: sessionInfo,
      historyReader: {} as never,
      activeConversationRegistry: {} as never,
      insightsEngine: {
        getCachedInsightsForSessions: async () => new Map(),
        backfillMissing,
      } as never,
      findRuntimeActiveSegment: () => null,
      getLatestSegmentForFallback: (conversation: { segments: Array<unknown> }) =>
        (conversation.segments[conversation.segments.length - 1] ?? null) as never,
    } as unknown as UnifiedConversationQueryRoutesContext;

    registerUnifiedConversationQueryRoutes(router, context);
    app = express();
    app.use('/api/conv', router);
  });

  afterEach(() => {
    ConversationService.resetInstance();
    DatabaseProvider.resetInstance();
  });

  it('returns identity images and merged segment metadata by default', async () => {
    const response = await request(app).get('/api/conv?archived=false');
    expect(response.status).toBe(200);

    const byId = new Map<string, ListedConversation>(
      (response.body.conversations as ListedConversation[]).map(c => [c.conversationId, c]),
    );
    expect(byId.size).toBe(2);

    const plain = byId.get(conversationIds.plain)!;
    expect(plain.identityImage).toBe(IMAGE);
    expect(plain.customName).toBe('Plain conversation');
    expect(plain.permissionMode).toBe('acceptEdits');
    // team_name lives only on the segment row.
    expect(plain.teamName).toBe('alpha');
    expect(plain.archived).toBe(false);
    expect(plain.pinCharacterImage).toBeNull();

    const pinned = byId.get(conversationIds.pinned)!;
    expect(pinned.pinned).toBe(true);
    expect(pinned.pinCharacterImage).toBe('character-portrait');
  });

  it('omits identity images when the client asks for the list without them', async () => {
    const response = await request(app).get('/api/conv?archived=false&includeIdentityImage=false');
    expect(response.status).toBe(200);

    const conversations = response.body.conversations as ListedConversation[];
    expect(conversations).toHaveLength(2);
    for (const conversation of conversations) {
      expect(conversation.identityImage).toBeNull();
    }

    // Everything else is unchanged, including the pinned portrait.
    const plain = conversations.find(c => c.conversationId === conversationIds.plain)!;
    expect(plain.teamName).toBe('alpha');
    expect(plain.customName).toBe('Plain conversation');
    const pinned = conversations.find(c => c.conversationId === conversationIds.pinned)!;
    expect(pinned.pinCharacterImage).toBe('character-portrait');
  });

  it('produces the same non-image fields either way', async () => {
    const withImages = await request(app).get('/api/conv?archived=false');
    const withoutImages = await request(app).get('/api/conv?archived=false&includeIdentityImage=false');

    const strip = (body: { conversations: ListedConversation[] }) =>
      body.conversations.map(({ identityImage: _identityImage, ...rest }) => rest);

    expect(strip(withoutImages.body)).toEqual(strip(withImages.body));
  });

  it('still serves the on-demand identity image route', async () => {
    const response = await request(app)
      .get(`/api/conv/${conversationIds.plain}/identity-image`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      conversationId: conversationIds.plain,
      identityImage: IMAGE,
    });
  });

  it('dispatches the mission backfill for the listed conversations', async () => {
    await request(app).get('/api/conv?archived=false');

    expect(backfillMissing).toHaveBeenCalledTimes(1);
    expect((backfillMissing.mock.calls[0][0] as string[]).sort()).toEqual(
      [conversationIds.plain, conversationIds.pinned].sort(),
    );
  });
});
