export function isUnifiedConversation(id?: string): boolean {
  return !!id && id.startsWith('conv-');
}
