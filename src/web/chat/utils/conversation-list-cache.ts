import type { UnifiedConversationSummary } from '../types';

export interface ConversationListCacheData {
  conversations: UnifiedConversationSummary[];
  hasMore: boolean;
  nextCursor: string | null;
  total: number;
}

export function removeConversationFromListCache(
  data: ConversationListCacheData | undefined,
  conversationId: string
): ConversationListCacheData | undefined {
  if (!data) {
    return data;
  }

  const nextConversations = data.conversations.filter(
    (conversation) => conversation.conversationId !== conversationId
  );

  if (nextConversations.length === data.conversations.length) {
    return data;
  }

  return {
    ...data,
    conversations: nextConversations,
    total: Math.max(0, data.total - 1),
  };
}
