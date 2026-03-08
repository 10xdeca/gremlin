import type Anthropic from "@anthropic-ai/sdk";
import { eq, desc } from "drizzle-orm";
import { db, schema, sqlite } from "../db/client.js";

/**
 * Maximum individual messages kept in the sliding window.
 * A tool-heavy turn uses ~4-6 messages, so 40 gives ~6-10 tool turns
 * or 20 simple text-only turns.
 */
const MAX_MESSAGES = 40;
const TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Maximum length for tool_result content blocks stored in DB. */
const MAX_TOOL_RESULT_LENGTH = 4000;

/**
 * In-memory history tracks complete turns (each sub-array is one user→response cycle).
 * getHistory() flattens turns for the Claude API.
 */
interface ChatHistory {
  turns: Anthropic.Messages.MessageParam[][];
  lastActivity: number;
}

/** In-memory L1 cache — fast path for hot conversations. */
const histories = new Map<number, ChatHistory>();

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Serialize message content for DB storage.
 * String content passes through; array content (tool_use, tool_result blocks)
 * is JSON-serialized.
 */
function serializeContent(content: Anthropic.Messages.MessageParam["content"]): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

/**
 * Deserialize content loaded from DB back to its original type.
 * Plain text passes through unchanged. JSON arrays (tool blocks) are parsed back.
 * Backward compatible with existing plain-text rows.
 */
function deserializeContent(raw: string): string | Anthropic.Messages.ContentBlockParam[] {
  if (!raw.startsWith("[")) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : raw;
  } catch {
    return raw;
  }
}

/**
 * Truncate tool_result content blocks that exceed MAX_TOOL_RESULT_LENGTH.
 * Only affects the copy written to DB — the current turn keeps full results.
 */
function truncateToolResults(
  messages: Anthropic.Messages.MessageParam[],
): Anthropic.Messages.MessageParam[] {
  return messages.map((msg) => {
    if (typeof msg.content === "string") return msg;

    const content = (msg.content as Anthropic.Messages.ContentBlockParam[]).map((block) => {
      if (
        block.type === "tool_result" &&
        typeof block.content === "string" &&
        block.content.length > MAX_TOOL_RESULT_LENGTH
      ) {
        return {
          ...block,
          content: block.content.slice(0, MAX_TOOL_RESULT_LENGTH) + "… [truncated]",
        };
      }
      return block;
    });

    return { ...msg, content };
  });
}

// ---------------------------------------------------------------------------
// Turn reconstruction (for DB loads)
// ---------------------------------------------------------------------------

/**
 * Trim loaded messages to valid turn boundaries.
 * - From the front: skip until the first user message with string content
 *   (not a tool_result array — those are mid-turn continuations).
 * - From the back: skip until the last assistant message with string content.
 */
function trimToValidBoundaries(
  messages: Anthropic.Messages.MessageParam[],
): Anthropic.Messages.MessageParam[] {
  // Find first "real" user message (string content = start of a turn)
  let start = 0;
  while (start < messages.length) {
    const msg = messages[start];
    if (msg.role === "user" && typeof msg.content === "string") break;
    start++;
  }

  // Find last assistant message with string content
  let end = messages.length - 1;
  while (end >= start) {
    const msg = messages[end];
    if (msg.role === "assistant" && typeof msg.content === "string") break;
    end--;
  }

  if (start > end) return [];
  return messages.slice(start, end + 1);
}

/**
 * Group flat messages back into turns. A new turn starts at each user message
 * with string content (as opposed to tool_result arrays which are mid-turn).
 */
function reconstructTurns(
  messages: Anthropic.Messages.MessageParam[],
): Anthropic.Messages.MessageParam[][] {
  const turns: Anthropic.Messages.MessageParam[][] = [];
  let current: Anthropic.Messages.MessageParam[] = [];

  for (const msg of messages) {
    // A user message with string content starts a new turn
    if (msg.role === "user" && typeof msg.content === "string") {
      if (current.length > 0) {
        turns.push(current);
      }
      current = [msg];
    } else {
      current.push(msg);
    }
  }

  if (current.length > 0) {
    turns.push(current);
  }

  return turns;
}

// ---------------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------------

/**
 * Load conversation from DB, respecting TTL.
 * Deserializes JSON content blocks and trims to valid turn boundaries.
 */
function loadFromDb(chatId: number): Anthropic.Messages.MessageParam[][] {
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
    const rows = db
      .select()
      .from(schema.conversationMessages)
      .where(eq(schema.conversationMessages.telegramChatId, chatId))
      .orderBy(desc(schema.conversationMessages.createdAt), desc(schema.conversationMessages.id))
      .limit(MAX_MESSAGES)
      .all()
      .reverse();

    const messages: Anthropic.Messages.MessageParam[] = rows.map((row) => ({
      role: row.role as "user" | "assistant",
      content: deserializeContent(row.content),
    }));

    // Trim orphaned fragments at window boundaries, then group into turns
    const trimmed = trimToValidBoundaries(messages);
    return reconstructTurns(trimmed);
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
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    )
`);

/**
 * Write all messages from a turn to DB and trim excess.
 * Each message's content is serialized — string content stays as-is,
 * array content (tool blocks) is JSON-serialized.
 */
function writeToDb(
  chatId: number,
  turnMessages: Anthropic.Messages.MessageParam[],
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

    // Truncate large tool results before storing
    const toStore = truncateToolResults(turnMessages);

    // Insert all messages from the turn
    const values = toStore.map((msg) => ({
      telegramChatId: chatId,
      role: msg.role,
      content: serializeContent(msg.content),
      createdAt: now,
    }));

    if (values.length > 0) {
      db.insert(schema.conversationMessages).values(values).run();
    }

    // Trim excess messages beyond the sliding window
    trimStmt.run(chatId, chatId, MAX_MESSAGES);
  } catch (err) {
    console.error(`[conversation-history] Failed to write to DB for chat ${chatId}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get conversation history for a chat. Cache-first, falls back to DB on miss. */
export function getHistory(chatId: number): Anthropic.Messages.MessageParam[] {
  const entry = histories.get(chatId);
  if (entry) {
    // Check TTL
    if (Date.now() - entry.lastActivity > TTL_MS) {
      histories.delete(chatId);
      return [];
    }
    return entry.turns.flat();
  }

  // Cache miss — try to reload from DB
  const turns = loadFromDb(chatId);
  if (turns.length > 0) {
    histories.set(chatId, { turns, lastActivity: Date.now() });
  }
  return turns.flat();
}

/**
 * Append a complete turn to conversation history.
 * A turn is the full message sequence for one user interaction:
 * [user, assistant/tool_use, user/tool_result, ..., assistant/text]
 */
export function appendToHistory(
  chatId: number,
  turnMessages: Anthropic.Messages.MessageParam[],
): void {
  let entry = histories.get(chatId);
  if (!entry || Date.now() - entry.lastActivity > TTL_MS) {
    entry = { turns: [], lastActivity: Date.now() };
  }

  entry.turns.push(turnMessages);
  entry.lastActivity = Date.now();

  // Sliding window: evict oldest complete turns until under MAX_MESSAGES
  let totalMessages = entry.turns.reduce((sum, turn) => sum + turn.length, 0);
  while (totalMessages > MAX_MESSAGES && entry.turns.length > 1) {
    const evicted = entry.turns.shift()!;
    totalMessages -= evicted.length;
  }

  histories.set(chatId, entry);

  // Write-through to DB
  writeToDb(chatId, turnMessages);
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

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _testOnly = {
  serializeContent,
  deserializeContent,
  truncateToolResults,
  trimToValidBoundaries,
  reconstructTurns,
  MAX_TOOL_RESULT_LENGTH,
};
