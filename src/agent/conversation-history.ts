import type Anthropic from "@anthropic-ai/sdk";

const MAX_MESSAGES = 20;
const TTL_MS = 30 * 60 * 1000; // 30 minutes

interface ChatHistory {
  messages: Anthropic.Messages.MessageParam[];
  lastActivity: number;
}

const histories = new Map<number, ChatHistory>();

/** Get conversation history for a chat (creates empty if none). */
export function getHistory(chatId: number): Anthropic.Messages.MessageParam[] {
  const entry = histories.get(chatId);
  if (!entry) return [];
  // Expired
  if (Date.now() - entry.lastActivity > TTL_MS) {
    histories.delete(chatId);
    return [];
  }
  return entry.messages;
}

/** Append a user message and assistant response to conversation history. */
export function appendToHistory(
  chatId: number,
  userMessage: Anthropic.Messages.MessageParam,
  assistantMessage: Anthropic.Messages.MessageParam
): void {
  let entry = histories.get(chatId);
  if (!entry || Date.now() - entry.lastActivity > TTL_MS) {
    entry = { messages: [], lastActivity: Date.now() };
  }

  entry.messages.push(userMessage, assistantMessage);
  entry.lastActivity = Date.now();

  // Sliding window: keep last MAX_MESSAGES messages (always in user/assistant pairs)
  while (entry.messages.length > MAX_MESSAGES) {
    // Remove oldest pair
    entry.messages.shift();
    entry.messages.shift();
  }

  histories.set(chatId, entry);
}

/** Clear history for a chat. */
export function clearHistory(chatId: number): void {
  histories.delete(chatId);
}

// Evict stale entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [chatId, entry] of histories) {
    if (now - entry.lastActivity > TTL_MS) {
      histories.delete(chatId);
    }
  }
}, 10 * 60 * 1000);
