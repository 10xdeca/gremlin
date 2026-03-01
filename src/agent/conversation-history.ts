import type Anthropic from "@anthropic-ai/sdk";
import { eq, desc } from "drizzle-orm";
import { db, schema, sqlite } from "../db/client.js";

const MAX_MESSAGES = 20;
const TTL_MS = 30 * 60 * 1000; // 30 minutes

interface ChatHistory {
  messages: Anthropic.Messages.MessageParam[];
  lastActivity: number;
}

/** In-memory L1 cache — fast path for hot conversations. */
const histories = new Map<number, ChatHistory>();

/**
 * Extract string content from a MessageParam.
 * String content passes through; array content is JSON-serialized (defensive).
 */
function extractContent(content: Anthropic.Messages.MessageParam["content"]): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

/**
 * Load conversation from DB, respecting TTL.
 * Returns messages in chronological order, or empty array if expired/missing.
 */
function loadFromDb(chatId: number): Anthropic.Messages.MessageParam[] {
  try {
    const conv = db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.telegramChatId, chatId))
      .get();

    if (!conv) return [];

    // Check TTL against last_activity
    const lastActivity = conv.lastActivity instanceof Date
      ? conv.lastActivity.getTime()
      : (conv.lastActivity as number) * 1000;
    if (Date.now() - lastActivity > TTL_MS) return [];

    // Load last MAX_MESSAGES messages, newest first, then reverse.
    // Secondary sort by id ensures user→assistant ordering within same second.
    const rows = db
      .select()
      .from(schema.conversationMessages)
      .where(eq(schema.conversationMessages.telegramChatId, chatId))
      .orderBy(desc(schema.conversationMessages.createdAt), desc(schema.conversationMessages.id))
      .limit(MAX_MESSAGES)
      .all()
      .reverse();

    return rows.map((row) => ({
      role: row.role as "user" | "assistant",
      content: row.content,
    }));
  } catch (err) {
    console.error(`[conversation-history] Failed to load from DB for chat ${chatId}:`, err);
    return [];
  }
}

/** Prepared statement for trimming old messages beyond the sliding window. */
const trimStmt = sqlite.prepare(`
  DELETE FROM conversation_messages
  WHERE telegram_chat_id = ?
    AND id NOT IN (
      SELECT id FROM conversation_messages
      WHERE telegram_chat_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    )
`);

/** Write messages to DB and trim excess. */
function writeToDb(
  chatId: number,
  userContent: string,
  assistantContent: string,
): void {
  try {
    const now = new Date();

    // Upsert conversation row (update last_activity if exists)
    db.insert(schema.conversations)
      .values({
        telegramChatId: chatId,
        createdAt: now,
        lastActivity: now,
      })
      .onConflictDoUpdate({
        target: schema.conversations.telegramChatId,
        set: { lastActivity: now },
      })
      .run();

    // Insert both messages
    db.insert(schema.conversationMessages)
      .values([
        { telegramChatId: chatId, role: "user", content: userContent, createdAt: now },
        { telegramChatId: chatId, role: "assistant", content: assistantContent, createdAt: now },
      ])
      .run();

    // Trim excess messages beyond the sliding window
    trimStmt.run(chatId, chatId, MAX_MESSAGES);
  } catch (err) {
    console.error(`[conversation-history] Failed to write to DB for chat ${chatId}:`, err);
  }
}

/** Get conversation history for a chat. Cache-first, falls back to DB on miss. */
export function getHistory(chatId: number): Anthropic.Messages.MessageParam[] {
  const entry = histories.get(chatId);
  if (entry) {
    // Check TTL
    if (Date.now() - entry.lastActivity > TTL_MS) {
      histories.delete(chatId);
      return [];
    }
    return entry.messages;
  }

  // Cache miss — try to reload from DB
  const messages = loadFromDb(chatId);
  if (messages.length > 0) {
    histories.set(chatId, { messages, lastActivity: Date.now() });
  }
  return messages;
}

/** Append a user message and assistant response to conversation history. */
export function appendToHistory(
  chatId: number,
  userMessage: Anthropic.Messages.MessageParam,
  assistantMessage: Anthropic.Messages.MessageParam,
): void {
  let entry = histories.get(chatId);
  if (!entry || Date.now() - entry.lastActivity > TTL_MS) {
    entry = { messages: [], lastActivity: Date.now() };
  }

  entry.messages.push(userMessage, assistantMessage);
  entry.lastActivity = Date.now();

  // Sliding window: keep last MAX_MESSAGES messages (always in user/assistant pairs)
  while (entry.messages.length > MAX_MESSAGES) {
    entry.messages.shift();
    entry.messages.shift();
  }

  histories.set(chatId, entry);

  // Write-through to DB
  const userContent = extractContent(userMessage.content);
  const assistantContent = extractContent(assistantMessage.content);
  writeToDb(chatId, userContent, assistantContent);
}

/** Clear history for a chat (both cache and DB). */
export function clearHistory(chatId: number): void {
  histories.delete(chatId);

  try {
    db.delete(schema.conversationMessages)
      .where(eq(schema.conversationMessages.telegramChatId, chatId))
      .run();
    db.delete(schema.conversations)
      .where(eq(schema.conversations.telegramChatId, chatId))
      .run();
  } catch (err) {
    console.error(`[conversation-history] Failed to clear DB for chat ${chatId}:`, err);
  }
}

// Evict stale entries from in-memory cache every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [chatId, entry] of histories) {
    if (now - entry.lastActivity > TTL_MS) {
      histories.delete(chatId);
    }
  }
}, 10 * 60 * 1000);
