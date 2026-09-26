import type { ConversationMessage } from '@/types/index.js';
import type { UnifiedMessage } from '@/types/unified-messages.js';

export function mapUnifiedMessageToConversationMessage(
  message: UnifiedMessage,
  sessionId: string
): ConversationMessage {
  const contentBlocks = message.content.map((block) => {
    switch (block.type) {
      case 'text':
        return { type: 'text' as const, text: block.text };
      case 'thinking':
        // Handle both canonical unified shape (`text`) and legacy shape (`thinking`).
        const legacyThinking = (block as { thinking?: unknown }).thinking;
        return {
          type: 'thinking' as const,
          thinking: typeof block.text === 'string'
            ? block.text
            : typeof legacyThinking === 'string'
              ? legacyThinking
              : '',
          signature: '',
        };
      case 'tool_use':
        return { type: 'tool_use' as const, id: block.id, name: block.name, input: block.input };
      case 'tool_result':
        return {
          type: 'tool_result' as const,
          tool_use_id: block.toolUseId,
          content: block.output,
          is_error: block.isError === true,
        };
      case 'image':
        return { type: 'image' as const, source: block.source };
      case 'document':
        return { type: 'document' as const, source: block.source };
      default:
        return { type: 'text' as const, text: '' };
    }
  });

  return {
    uuid: message.id,
    type: message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'system',
    message: {
      role: message.role === 'system' ? 'assistant' : message.role,
      content: contentBlocks,
    } as ConversationMessage['message'],
    timestamp: message.timestamp,
    sessionId,
    provider: message.provider,
  };
}
