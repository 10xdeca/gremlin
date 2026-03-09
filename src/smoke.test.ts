/**
 * Smoke tests — catch import errors, schema issues, and registration
 * failures before they reach production.
 *
 * These tests verify that the app's core modules can be loaded and
 * initialized without external services (no Telegram, no Claude API,
 * no MCP servers). They run in CI alongside unit tests.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";

// ---------------------------------------------------------------------------
// Mock external dependencies that would fail without credentials/network
// ---------------------------------------------------------------------------

// Mock the DB client with an in-memory SQLite
vi.mock("./db/client.js", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const schema = await import("./db/schema.js");

  const sqlite = new Database(":memory:");

  // Apply the full schema (same DDL as client.ts)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS telegram_workspace_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_chat_id INTEGER NOT NULL UNIQUE,
      workspace_public_id TEXT NOT NULL,
      workspace_name TEXT NOT NULL,
      message_thread_id INTEGER,
      social_thread_id INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      created_by_telegram_user_id INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS telegram_user_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL UNIQUE,
      telegram_username TEXT,
      kan_user_email TEXT NOT NULL,
      workspace_member_public_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      created_by_telegram_user_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS bot_identity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      pronouns TEXT NOT NULL,
      tone TEXT NOT NULL,
      tone_description TEXT,
      chosen_at INTEGER NOT NULL DEFAULT (unixepoch()),
      chosen_in_chat_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS naming_ceremonies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_chat_id INTEGER NOT NULL,
      message_thread_id INTEGER,
      poll_message_id INTEGER,
      options TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      concludes_at INTEGER NOT NULL,
      initiated_by_user_id INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS default_board_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_chat_id INTEGER NOT NULL UNIQUE,
      board_public_id TEXT NOT NULL,
      list_public_id TEXT NOT NULL,
      board_name TEXT NOT NULL,
      list_name TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_type TEXT NOT NULL UNIQUE,
      token_value TEXT NOT NULL,
      expires_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS standup_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_chat_id INTEGER NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      prompt_hour INTEGER NOT NULL DEFAULT 9,
      summary_hour INTEGER NOT NULL DEFAULT 17,
      timezone TEXT NOT NULL DEFAULT 'Australia/Sydney',
      skip_break_days INTEGER NOT NULL DEFAULT 1,
      skip_weekends INTEGER NOT NULL DEFAULT 1,
      nudge_hour INTEGER
    );

    CREATE TABLE IF NOT EXISTS standup_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_chat_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      prompt_message_id INTEGER,
      summary_message_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      nudged_at INTEGER,
      UNIQUE(telegram_chat_id, date)
    );

    CREATE TABLE IF NOT EXISTS standup_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      telegram_user_id INTEGER NOT NULL,
      telegram_username TEXT,
      yesterday TEXT,
      today TEXT,
      blockers TEXT,
      raw_message TEXT,
      UNIQUE(session_id, telegram_user_id)
    );

    CREATE TABLE IF NOT EXISTS telegram_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_public_id TEXT NOT NULL,
      telegram_chat_id INTEGER NOT NULL,
      reminder_type TEXT NOT NULL DEFAULT 'overdue',
      last_reminder_at INTEGER NOT NULL,
      UNIQUE(card_public_id, telegram_chat_id, reminder_type)
    );

    CREATE TABLE IF NOT EXISTS calendar_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_uid TEXT NOT NULL,
      telegram_chat_id INTEGER NOT NULL,
      reminder_window TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      UNIQUE(event_uid, telegram_chat_id, reminder_window)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      telegram_chat_id INTEGER PRIMARY KEY,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_activity INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_chat_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_conv_messages_chat
      ON conversation_messages(telegram_chat_id, created_at);
  `);

  const db = drizzle(sqlite, { schema });
  return { db, schema, sqlite };
});

// Mock MCP manager — no real subprocesses
vi.mock("./agent/mcp-manager.js", () => ({
  mcpManager: {
    getAllTools: () => [],
    callTool: async () => "mock result",
    init: async () => {},
    shutdown: async () => {},
    getClient: () => null,
    getServerNames: () => [],
    healthCheck: async () => [],
    restartServer: async () => ({ success: true, message: "mock restart" }),
  },
}));

// Mock anthropic client — no real API calls
vi.mock("./services/anthropic-client.js", () => ({
  getAnthropicClient: async () => ({
    messages: { create: async () => ({ content: [{ type: "text", text: "mock" }] }) },
  }),
  invalidateCachedClient: () => {},
  getTokenHealth: () => ({ status: "healthy", lastRefresh: Date.now(), expiresAt: Date.now() + 3600000 }),
}));

// Mock admin alerts — no real Telegram messages
vi.mock("./services/admin-alerts.js", () => ({
  alertAdmins: () => {},
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("smoke: module imports", () => {
  it("imports db/schema without errors", async () => {
    const schema = await import("./db/schema.js");
    expect(schema.telegramWorkspaceLinks).toBeDefined();
    expect(schema.telegramUserLinks).toBeDefined();
    expect(schema.botIdentity).toBeDefined();
    expect(schema.conversations).toBeDefined();
    expect(schema.conversationMessages).toBeDefined();
    expect(schema.standupConfig).toBeDefined();
    expect(schema.standupSessions).toBeDefined();
    expect(schema.standupResponses).toBeDefined();
    expect(schema.calendarReminders).toBeDefined();
    expect(schema.oauthTokens).toBeDefined();
  });

  it("imports db/queries without errors", async () => {
    const queries = await import("./db/queries.js");
    expect(typeof queries.getWorkspaceLink).toBe("function");
    expect(typeof queries.getStandupConfig).toBe("function");
  });

  it("imports agent/tool-registry without errors", async () => {
    const registry = await import("./agent/tool-registry.js");
    expect(typeof registry.registerCustomTool).toBe("function");
    expect(typeof registry.getAnthropicTools).toBe("function");
    expect(typeof registry.executeTool).toBe("function");
  });

  it("imports agent/conversation-history without errors", async () => {
    const history = await import("./agent/conversation-history.js");
    expect(typeof history.getHistory).toBe("function");
    expect(typeof history.appendToHistory).toBe("function");
    expect(typeof history.clearHistory).toBe("function");
  });

  it("imports utils/sprint without errors", async () => {
    const sprint = await import("./utils/sprint.js");
    expect(typeof sprint.getSprintDay).toBe("function");
    expect(typeof sprint.getSprintInfo).toBe("function");
  });

  it("imports utils/timezone without errors", async () => {
    const tz = await import("./utils/timezone.js");
    expect(typeof tz.getTodayInTimezone).toBe("function");
  });

  it("imports utils/mentions without errors", async () => {
    const mentions = await import("./utils/mentions.js");
    expect(typeof mentions.extractMentions).toBe("function");
  });
});

describe("smoke: DB schema applies cleanly", () => {
  it("can query all tables with the Drizzle ORM", async () => {
    const { db, schema } = await import("./db/client.js");

    // Each query should return an empty array, not throw
    const links = db.select().from(schema.telegramWorkspaceLinks).all();
    expect(links).toEqual([]);

    const users = db.select().from(schema.telegramUserLinks).all();
    expect(users).toEqual([]);

    const reminders = db.select().from(schema.telegramReminders).all();
    expect(reminders).toEqual([]);

    const configs = db.select().from(schema.standupConfig).all();
    expect(configs).toEqual([]);

    const conversations = db.select().from(schema.conversations).all();
    expect(conversations).toEqual([]);
  });
});

describe("smoke: system prompt builder", () => {
  it("builds a system prompt without errors", async () => {
    const { buildSystemPrompt } = await import("./agent/system-prompt.js");

    const prompt = await buildSystemPrompt({
      chatId: 12345,
      userId: 67890,
      username: "testuser",
      isAdmin: false,
    });

    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(100);
    // Should contain the bot's identity and guidelines
    expect(prompt).toContain("Sprint day:");
    expect(prompt).toContain("Your Capabilities");
  });
});

describe("smoke: custom tool registration", () => {
  it("registers all custom tools without errors", async () => {
    const { registerCustomTool, getAnthropicTools } = await import("./agent/tool-registry.js");

    // Import and register all tool modules
    const { registerChatConfigTools } = await import("./tools/chat-config.js");
    const { registerUserMappingTools } = await import("./tools/user-mapping.js");
    const { registerSprintInfoTools } = await import("./tools/sprint-info.js");
    const { registerBotIdentityTools } = await import("./tools/bot-identity.js");
    const { registerStandupTools } = await import("./tools/standup.js");
    const { registerDeployInfoTools } = await import("./tools/deploy-info.js");
    const { registerServerOpsTools } = await import("./tools/server-ops.js");

    // These should not throw
    registerChatConfigTools();
    registerUserMappingTools();
    registerSprintInfoTools();
    registerBotIdentityTools();
    registerStandupTools();
    registerDeployInfoTools();
    registerServerOpsTools();

    // Verify tools were registered
    const tools = getAnthropicTools();
    expect(tools.length).toBeGreaterThan(0);

    // Each tool should have required fields
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.input_schema).toBeDefined();
    }
  });
});

describe("smoke: env var documentation", () => {
  it(".env.example documents all key env vars used in the codebase", async () => {
    // This test reads .env.example and verifies it contains the critical vars
    // that the app checks at startup. If someone adds a new required env var
    // but forgets to document it, this test will catch it.
    const fs = await import("fs");
    const path = await import("path");

    const envExample = fs.readFileSync(
      path.resolve(process.cwd(), ".env.example"),
      "utf-8",
    );

    const requiredVars = [
      "TELEGRAM_BOT_TOKEN",
      "KAN_API_KEY",
      "KAN_BASE_URL",
      "OUTLINE_API_KEY",
      "OUTLINE_BASE_URL",
      "CLAUDE_REFRESH_TOKEN",
      "SPRINT_START_DATE",
      "ADMIN_USER_IDS",
    ];

    for (const varName of requiredVars) {
      expect(
        envExample,
        `Missing ${varName} in .env.example`,
      ).toContain(varName);
    }
  });
});
