import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock ../db/client.js with an in-memory SQLite database
vi.mock("../db/client.js", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const schema = await import("../db/schema.js");

  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE conversations (
      telegram_chat_id INTEGER PRIMARY KEY,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_activity INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_chat_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX idx_conv_messages_chat ON conversation_messages(telegram_chat_id, created_at);
  `);
  const db = drizzle(sqlite, { schema });

  return { db, schema, sqlite };
});

// These resolve to the mocked in-memory instances
import { sqlite } from "../db/client.js";
import { getHistory, appendToHistory, clearHistory } from "./conversation-history.js";

// Use unique chat IDs per test to avoid in-memory cache interference
let nextChatId = 1000;

describe("conversation-history", () => {
  beforeEach(() => {
    // Clean DB tables between tests (cache uses unique IDs so no interference)
    sqlite.exec("DELETE FROM conversation_messages");
    sqlite.exec("DELETE FROM conversations");
  });

  it("returns empty array for unknown chat", () => {
    expect(getHistory(nextChatId++)).toEqual([]);
  });

  it("appends and retrieves messages", () => {
    const chatId = nextChatId++;
    appendToHistory(
      chatId,
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    );

    const history = getHistory(chatId);
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: "user", content: "Hello" });
    expect(history[1]).toEqual({ role: "assistant", content: "Hi there" });
  });

  it("enforces sliding window of 20 messages (10 pairs)", () => {
    const chatId = nextChatId++;
    // Append 12 pairs = 24 messages; window keeps last 10 pairs = 20 messages
    for (let i = 0; i < 12; i++) {
      appendToHistory(
        chatId,
        { role: "user", content: `User ${i}` },
        { role: "assistant", content: `Bot ${i}` },
      );
    }

    const history = getHistory(chatId);
    expect(history).toHaveLength(20);
    // Pairs 0 and 1 should be evicted — first message is from pair 2
    expect(history[0]).toEqual({ role: "user", content: "User 2" });
    expect(history[history.length - 1]).toEqual({ role: "assistant", content: "Bot 11" });
  });

  it("clears history from both cache and DB", () => {
    const chatId = nextChatId++;
    appendToHistory(
      chatId,
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    );

    clearHistory(chatId);

    expect(getHistory(chatId)).toEqual([]);

    // Verify DB is also cleared
    const msgCount = sqlite
      .prepare("SELECT COUNT(*) as cnt FROM conversation_messages WHERE telegram_chat_id = ?")
      .get(chatId) as { cnt: number };
    expect(msgCount.cnt).toBe(0);

    const conv = sqlite
      .prepare("SELECT * FROM conversations WHERE telegram_chat_id = ?")
      .get(chatId);
    expect(conv).toBeUndefined();
  });

  it("writes through to DB on append", () => {
    const chatId = nextChatId++;
    appendToHistory(
      chatId,
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    );

    const msgs = sqlite
      .prepare("SELECT role, content FROM conversation_messages WHERE telegram_chat_id = ? ORDER BY created_at")
      .all(chatId) as { role: string; content: string }[];

    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: "user", content: "Hello" });
    expect(msgs[1]).toEqual({ role: "assistant", content: "Hi" });

    // Verify conversations row exists
    const conv = sqlite
      .prepare("SELECT * FROM conversations WHERE telegram_chat_id = ?")
      .get(chatId);
    expect(conv).toBeDefined();
  });

  it("reloads from DB on cache miss (simulates restart)", () => {
    const chatId = nextChatId++;
    const now = Math.floor(Date.now() / 1000);

    // Insert directly into DB — simulates data persisted from a prior session
    sqlite
      .prepare("INSERT INTO conversations (telegram_chat_id, created_at, last_activity) VALUES (?, ?, ?)")
      .run(chatId, now, now);
    sqlite
      .prepare("INSERT INTO conversation_messages (telegram_chat_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(chatId, "user", "Old message", now);
    sqlite
      .prepare("INSERT INTO conversation_messages (telegram_chat_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(chatId, "assistant", "Old reply", now);

    // Cache has never seen this chatId → loads from DB
    const history = getHistory(chatId);
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: "user", content: "Old message" });
    expect(history[1]).toEqual({ role: "assistant", content: "Old reply" });
  });

  it("returns empty for expired conversations in DB", () => {
    const chatId = nextChatId++;
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;

    // Insert with stale last_activity (> 30 min TTL)
    sqlite
      .prepare("INSERT INTO conversations (telegram_chat_id, created_at, last_activity) VALUES (?, ?, ?)")
      .run(chatId, oneHourAgo, oneHourAgo);
    sqlite
      .prepare("INSERT INTO conversation_messages (telegram_chat_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(chatId, "user", "Stale message", oneHourAgo);
    sqlite
      .prepare("INSERT INTO conversation_messages (telegram_chat_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(chatId, "assistant", "Stale reply", oneHourAgo);

    // TTL check in loadFromDb should reject this
    expect(getHistory(chatId)).toEqual([]);
  });

  it("trims excess messages in DB beyond window size", () => {
    const chatId = nextChatId++;

    // Append 15 pairs = 30 messages; trim keeps only 20 in DB
    for (let i = 0; i < 15; i++) {
      appendToHistory(
        chatId,
        { role: "user", content: `Msg ${i}` },
        { role: "assistant", content: `Reply ${i}` },
      );
    }

    const count = sqlite
      .prepare("SELECT COUNT(*) as cnt FROM conversation_messages WHERE telegram_chat_id = ?")
      .get(chatId) as { cnt: number };
    expect(count.cnt).toBe(20);

    // Verify the remaining messages are the most recent ones
    const oldest = sqlite
      .prepare("SELECT content FROM conversation_messages WHERE telegram_chat_id = ? ORDER BY created_at ASC LIMIT 1")
      .get(chatId) as { content: string };
    expect(oldest.content).toBe("Msg 5");
  });
});
