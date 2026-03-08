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
import { getHistory, appendToHistory, clearHistory, _testOnly } from "./conversation-history.js";

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
    appendToHistory(chatId, [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]);

    const history = getHistory(chatId);
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: "user", content: "Hello" });
    expect(history[1]).toEqual({ role: "assistant", content: "Hi there" });
  });

  it("enforces sliding window by evicting oldest turns", () => {
    const chatId = nextChatId++;
    // Append 25 simple turns = 50 messages; window of 40 keeps last 20 turns
    for (let i = 0; i < 25; i++) {
      appendToHistory(chatId, [
        { role: "user", content: `User ${i}` },
        { role: "assistant", content: `Bot ${i}` },
      ]);
    }

    const history = getHistory(chatId);
    expect(history).toHaveLength(40);
    // Turns 0-4 (10 messages) should be evicted — first message is from turn 5
    expect(history[0]).toEqual({ role: "user", content: "User 5" });
    expect(history[history.length - 1]).toEqual({ role: "assistant", content: "Bot 24" });
  });

  it("clears history from both cache and DB", () => {
    const chatId = nextChatId++;
    appendToHistory(chatId, [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ]);

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
    appendToHistory(chatId, [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ]);

    const msgs = sqlite
      .prepare("SELECT role, content FROM conversation_messages WHERE telegram_chat_id = ? ORDER BY id")
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

    // Append 25 simple turns = 50 messages; trim keeps only 40 in DB
    for (let i = 0; i < 25; i++) {
      appendToHistory(chatId, [
        { role: "user", content: `Msg ${i}` },
        { role: "assistant", content: `Reply ${i}` },
      ]);
    }

    const count = sqlite
      .prepare("SELECT COUNT(*) as cnt FROM conversation_messages WHERE telegram_chat_id = ?")
      .get(chatId) as { cnt: number };
    expect(count.cnt).toBe(40);

    // Verify the remaining messages are the most recent ones
    const oldest = sqlite
      .prepare("SELECT content FROM conversation_messages WHERE telegram_chat_id = ? ORDER BY id ASC LIMIT 1")
      .get(chatId) as { content: string };
    expect(oldest.content).toBe("Msg 5");
  });

  // ---------------------------------------------------------------------------
  // New: Tool call context tests
  // ---------------------------------------------------------------------------

  it("preserves tool call round-trip in history", () => {
    const chatId = nextChatId++;
    const turn = [
      { role: "user" as const, content: "Create a card called Test" },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: "toolu_123",
            name: "kan_create_card",
            input: { title: "Test", board_id: "abc" },
          },
        ],
      },
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: "toolu_123",
            content: '{"publicId":"card_xyz","title":"Test"}',
          },
        ],
      },
      { role: "assistant" as const, content: "Done! Created card card_xyz." },
    ];

    appendToHistory(chatId, turn);

    const history = getHistory(chatId);
    expect(history).toHaveLength(4);
    expect(history[0]).toEqual({ role: "user", content: "Create a card called Test" });
    // Assistant tool_use block preserved
    expect(history[1].role).toBe("assistant");
    expect(Array.isArray(history[1].content)).toBe(true);
    const toolUse = (history[1].content as any[])[0];
    expect(toolUse.type).toBe("tool_use");
    expect(toolUse.name).toBe("kan_create_card");
    // User tool_result block preserved
    expect(history[2].role).toBe("user");
    expect(Array.isArray(history[2].content)).toBe(true);
    // Final text
    expect(history[3]).toEqual({ role: "assistant", content: "Done! Created card card_xyz." });
  });

  it("serializes structured content to DB as JSON", () => {
    const chatId = nextChatId++;
    const turn = [
      { role: "user" as const, content: "Create a card" },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: "toolu_456",
            name: "kan_create_card",
            input: { title: "Test" },
          },
        ],
      },
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: "toolu_456",
            content: '{"publicId":"card_abc"}',
          },
        ],
      },
      { role: "assistant" as const, content: "Created card_abc." },
    ];

    appendToHistory(chatId, turn);

    const rows = sqlite
      .prepare("SELECT role, content FROM conversation_messages WHERE telegram_chat_id = ? ORDER BY id")
      .all(chatId) as { role: string; content: string }[];

    expect(rows).toHaveLength(4);
    // User text stays as plain string
    expect(rows[0].content).toBe("Create a card");
    // Assistant tool_use is JSON-serialized
    expect(rows[1].content.startsWith("[")).toBe(true);
    const parsed1 = JSON.parse(rows[1].content);
    expect(parsed1[0].type).toBe("tool_use");
    // User tool_result is JSON-serialized
    expect(rows[2].content.startsWith("[")).toBe(true);
    const parsed2 = JSON.parse(rows[2].content);
    expect(parsed2[0].type).toBe("tool_result");
    // Final text stays as plain string
    expect(rows[3].content).toBe("Created card_abc.");
  });

  it("deserializes structured content from DB on cache miss", () => {
    const chatId = nextChatId++;
    const now = Math.floor(Date.now() / 1000);

    // Insert rows directly with JSON content (simulates restart with tool history)
    sqlite
      .prepare("INSERT INTO conversations (telegram_chat_id, created_at, last_activity) VALUES (?, ?, ?)")
      .run(chatId, now, now);

    const toolUseContent = JSON.stringify([
      { type: "tool_use", id: "toolu_789", name: "kan_get_card", input: { card_id: "xyz" } },
    ]);
    const toolResultContent = JSON.stringify([
      { type: "tool_result", tool_use_id: "toolu_789", content: '{"title":"My Card"}' },
    ]);

    sqlite
      .prepare("INSERT INTO conversation_messages (telegram_chat_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(chatId, "user", "Show card xyz", now);
    sqlite
      .prepare("INSERT INTO conversation_messages (telegram_chat_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(chatId, "assistant", toolUseContent, now);
    sqlite
      .prepare("INSERT INTO conversation_messages (telegram_chat_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(chatId, "user", toolResultContent, now);
    sqlite
      .prepare("INSERT INTO conversation_messages (telegram_chat_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(chatId, "assistant", "Here is your card: My Card", now);

    const history = getHistory(chatId);
    expect(history).toHaveLength(4);
    // Tool use block deserialized to array
    expect(Array.isArray(history[1].content)).toBe(true);
    expect((history[1].content as any[])[0].type).toBe("tool_use");
    // Tool result block deserialized to array
    expect(Array.isArray(history[2].content)).toBe(true);
    expect((history[2].content as any[])[0].type).toBe("tool_result");
  });

  it("truncates large tool results in DB", () => {
    const chatId = nextChatId++;
    const largeResult = "x".repeat(5000);
    const turn = [
      { role: "user" as const, content: "List all cards" },
      {
        role: "assistant" as const,
        content: [
          { type: "tool_use" as const, id: "toolu_big", name: "kan_list_cards", input: {} },
        ],
      },
      {
        role: "user" as const,
        content: [
          { type: "tool_result" as const, tool_use_id: "toolu_big", content: largeResult },
        ],
      },
      { role: "assistant" as const, content: "Found many cards." },
    ];

    appendToHistory(chatId, turn);

    // In-memory cache should still have full content
    const history = getHistory(chatId);
    const toolResultMsg = history[2];
    const toolResultBlock = (toolResultMsg.content as any[])[0];
    expect(toolResultBlock.content).toBe(largeResult); // Full in memory

    // DB should have truncated content
    const rows = sqlite
      .prepare("SELECT content FROM conversation_messages WHERE telegram_chat_id = ? ORDER BY id")
      .all(chatId) as { content: string }[];

    const dbToolResult = JSON.parse(rows[2].content);
    expect(dbToolResult[0].content.length).toBeLessThan(largeResult.length);
    expect(dbToolResult[0].content).toContain("… [truncated]");
    expect(dbToolResult[0].content.length).toBeLessThanOrEqual(
      _testOnly.MAX_TOOL_RESULT_LENGTH + "… [truncated]".length
    );
  });

  it("evicts complete turns, never orphaning tool_use/tool_result", () => {
    const chatId = nextChatId++;

    // Add tool turns (4 messages each = fills up faster)
    for (let i = 0; i < 12; i++) {
      appendToHistory(chatId, [
        { role: "user" as const, content: `Do thing ${i}` },
        {
          role: "assistant" as const,
          content: [
            { type: "tool_use" as const, id: `toolu_${i}`, name: "some_tool", input: {} },
          ],
        },
        {
          role: "user" as const,
          content: [
            { type: "tool_result" as const, tool_use_id: `toolu_${i}`, content: `result ${i}` },
          ],
        },
        { role: "assistant" as const, content: `Done ${i}` },
      ]);
    }

    // 12 turns × 4 = 48 messages. Window is 40, so 2 turns evicted → 10 × 4 = 40
    const history = getHistory(chatId);
    expect(history.length).toBeLessThanOrEqual(40);
    // First message should be a user message with string content (start of a turn)
    expect(history[0].role).toBe("user");
    expect(typeof history[0].content).toBe("string");
    // Verify no orphaned tool_result at the start
    expect((history[0].content as string).startsWith("Do thing")).toBe(true);
  });

  it("backward compatible with plain text DB rows (old format)", () => {
    const chatId = nextChatId++;
    const now = Math.floor(Date.now() / 1000);

    // Insert plain text rows (old format before this change)
    sqlite
      .prepare("INSERT INTO conversations (telegram_chat_id, created_at, last_activity) VALUES (?, ?, ?)")
      .run(chatId, now, now);
    sqlite
      .prepare("INSERT INTO conversation_messages (telegram_chat_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(chatId, "user", "Hello", now);
    sqlite
      .prepare("INSERT INTO conversation_messages (telegram_chat_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(chatId, "assistant", "Hi there!", now);

    const history = getHistory(chatId);
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: "user", content: "Hello" });
    expect(history[1]).toEqual({ role: "assistant", content: "Hi there!" });
  });

  it("trims orphaned tool_result at start of DB rows on load", () => {
    const chatId = nextChatId++;
    const now = Math.floor(Date.now() / 1000);

    // Simulate a window boundary that cuts mid-turn: starts with orphaned tool_result
    sqlite
      .prepare("INSERT INTO conversations (telegram_chat_id, created_at, last_activity) VALUES (?, ?, ?)")
      .run(chatId, now, now);

    // Orphaned tool_result (no preceding tool_use) — should be trimmed
    const orphanedContent = JSON.stringify([
      { type: "tool_result", tool_use_id: "toolu_old", content: "stale result" },
    ]);
    sqlite
      .prepare("INSERT INTO conversation_messages (telegram_chat_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(chatId, "user", orphanedContent, now);
    sqlite
      .prepare("INSERT INTO conversation_messages (telegram_chat_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(chatId, "assistant", "Based on that result...", now);

    // Then a complete turn
    sqlite
      .prepare("INSERT INTO conversation_messages (telegram_chat_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(chatId, "user", "What is 2+2?", now);
    sqlite
      .prepare("INSERT INTO conversation_messages (telegram_chat_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(chatId, "assistant", "4", now);

    const history = getHistory(chatId);
    // Orphaned fragment trimmed — only the complete turn remains
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: "user", content: "What is 2+2?" });
    expect(history[1]).toEqual({ role: "assistant", content: "4" });
  });
});

// ---------------------------------------------------------------------------
// Unit tests for helper functions
// ---------------------------------------------------------------------------

describe("conversation-history helpers", () => {
  describe("deserializeContent", () => {
    it("passes through plain text", () => {
      expect(_testOnly.deserializeContent("Hello world")).toBe("Hello world");
    });

    it("parses JSON arrays back to objects", () => {
      const json = JSON.stringify([{ type: "tool_use", id: "x", name: "y", input: {} }]);
      const result = _testOnly.deserializeContent(json);
      expect(Array.isArray(result)).toBe(true);
      expect((result as any[])[0].type).toBe("tool_use");
    });

    it("falls back to string for invalid JSON starting with [", () => {
      expect(_testOnly.deserializeContent("[not valid json")).toBe("[not valid json");
    });

    it("passes through text that starts with [ but parses to non-array", () => {
      // This shouldn't normally happen, but test the guard
      const result = _testOnly.deserializeContent("[invalid");
      expect(typeof result).toBe("string");
    });
  });

  describe("truncateToolResults", () => {
    it("does not truncate short results", () => {
      const messages: any[] = [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "x", content: "short result" },
          ],
        },
      ];
      const result = _testOnly.truncateToolResults(messages);
      expect((result[0].content as any[])[0].content).toBe("short result");
    });

    it("truncates results exceeding MAX_TOOL_RESULT_LENGTH", () => {
      const longContent = "a".repeat(5000);
      const messages: any[] = [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "x", content: longContent },
          ],
        },
      ];
      const result = _testOnly.truncateToolResults(messages);
      const truncated = (result[0].content as any[])[0].content;
      expect(truncated.length).toBeLessThan(longContent.length);
      expect(truncated).toContain("… [truncated]");
    });

    it("passes through string-content messages unchanged", () => {
      const messages: any[] = [
        { role: "user", content: "just text" },
      ];
      const result = _testOnly.truncateToolResults(messages);
      expect(result[0].content).toBe("just text");
    });
  });

  describe("trimToValidBoundaries", () => {
    it("trims orphaned tool_result from the start", () => {
      const messages: any[] = [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "r" }] },
        { role: "assistant", content: "text" },
        { role: "user", content: "real user message" },
        { role: "assistant", content: "real reply" },
      ];
      const result = _testOnly.trimToValidBoundaries(messages);
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe("real user message");
    });

    it("trims orphaned tool_use from the end", () => {
      const messages: any[] = [
        { role: "user", content: "question" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "follow-up" },
        { role: "assistant", content: [{ type: "tool_use", id: "x", name: "t", input: {} }] },
      ];
      const result = _testOnly.trimToValidBoundaries(messages);
      expect(result).toHaveLength(2);
      expect(result[1].content).toBe("answer");
    });

    it("returns empty for all-orphaned messages", () => {
      const messages: any[] = [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "r" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "x", name: "t", input: {} }] },
      ];
      const result = _testOnly.trimToValidBoundaries(messages);
      expect(result).toEqual([]);
    });
  });

  describe("reconstructTurns", () => {
    it("groups simple messages into turns", () => {
      const messages: any[] = [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "Bye" },
        { role: "assistant", content: "See ya" },
      ];
      const turns = _testOnly.reconstructTurns(messages);
      expect(turns).toHaveLength(2);
      expect(turns[0]).toHaveLength(2);
      expect(turns[1]).toHaveLength(2);
    });

    it("groups tool exchanges within a turn", () => {
      const messages: any[] = [
        { role: "user", content: "Create card" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "create", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        { role: "assistant", content: "Done" },
        { role: "user", content: "Thanks" },
        { role: "assistant", content: "Welcome" },
      ];
      const turns = _testOnly.reconstructTurns(messages);
      expect(turns).toHaveLength(2);
      expect(turns[0]).toHaveLength(4); // user, tool_use, tool_result, text
      expect(turns[1]).toHaveLength(2); // user, text
    });
  });
});
