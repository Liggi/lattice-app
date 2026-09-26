import Anthropic from '@anthropic-ai/sdk';
import { ConversationMessage } from '@/types/index.js';
import { createLogger, type Logger } from './infrastructure/logger.js';

/**
 * Filters out local command messages from conversation history
 */
export class MessageFilter {
  private logger: Logger;
  private filteredPrefixes: string[] = [
    'Caveat: ',
    '<command-name>',
    '<local-command-stdout>'
  ];

  constructor() {
    this.logger = createLogger('MessageFilter');
  }

  /**
   * Filter an array of conversation messages
   */
  filterMessages(messages: ConversationMessage[], context?: string): ConversationMessage[] {
    const before = messages.length;
    const result = messages.filter(message => this.shouldKeepMessage(message));
    const removed = before - result.length;
    if (removed > 0) {
      this.logger.debug('Filtered messages', {
        context: context ?? 'unknown',
        before,
        after: result.length,
        removed,
        removedTypes: messages
          .filter(m => !this.shouldKeepMessage(m))
          .map(m => {
            const text = this.extractTextContent(m.message);
            return { type: m.type, prefix: text?.slice(0, 60) };
          })
      });
    }
    return result;
  }

  /**
   * Determine if a message should be kept (not filtered out)
   */
  private shouldKeepMessage(message: ConversationMessage): boolean {
    // Only filter user messages with text content
    if (message.type !== 'user') {
      return true;
    }

    const textContent = this.extractTextContent(message.message);
    if (!textContent) {
      return true; // Keep messages without text content
    }

    // Check if the text starts with any filtered prefix
    const shouldFilter = this.filteredPrefixes.some(prefix => 
      textContent.trim().startsWith(prefix)
    );

    return !shouldFilter;
  }

  /**
   * Extract text content from Anthropic message object
   */
  private extractTextContent(message: Anthropic.Message | Anthropic.MessageParam | string): string | null {
    if (typeof message === 'string') {
      return message;
    }

    if (message.content) {
      if (typeof message.content === 'string') {
        return message.content;
      }

      if (Array.isArray(message.content)) {
        // Find first text content block
        const textBlock = message.content.find((block) => block.type === 'text');
        return textBlock && 'text' in textBlock ? textBlock.text : null;
      }
    }

    return null;
  }
}