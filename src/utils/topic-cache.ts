/** Shared topic cache — used by index.ts for lookups and chat-config tools for invalidation. */

interface TopicCacheEntry {
  pmThreadId: number | null;
  socialThreadId: number | null;
  expiresAt: number;
}

export const topicCache = new Map<number, TopicCacheEntry>();

/** Invalidate cached topic config for a chat so changes take effect immediately. */
export function invalidateTopicCache(chatId: number): void {
  topicCache.delete(chatId);
}
