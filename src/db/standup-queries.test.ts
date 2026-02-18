import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, and } from "drizzle-orm";
import * as schema from "./schema.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE standup_config (
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

    CREATE TABLE standup_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_chat_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      prompt_message_id INTEGER,
      summary_message_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      nudged_at INTEGER,
      UNIQUE(telegram_chat_id, date)
    );

    CREATE TABLE standup_responses (
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
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe("standup queries", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    db = testDb.db;
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("standupConfig", () => {
    it("returns null when no config exists", () => {
      const results = db
        .select()
        .from(schema.standupConfig)
        .where(eq(schema.standupConfig.telegramChatId, 123))
        .all();
      expect(results[0] || null).toBeNull();
    });

    it("inserts a new config with defaults", () => {
      db.insert(schema.standupConfig)
        .values({ telegramChatId: 123 })
        .run();

      const results = db
        .select()
        .from(schema.standupConfig)
        .where(eq(schema.standupConfig.telegramChatId, 123))
        .all();

      const config = results[0];
      expect(config).not.toBeNull();
      expect(config!.enabled).toBe(true);
      expect(config!.promptHour).toBe(9);
      expect(config!.summaryHour).toBe(17);
      expect(config!.timezone).toBe("Australia/Sydney");
      expect(config!.skipBreakDays).toBe(true);
      expect(config!.skipWeekends).toBe(true);
    });

    it("upserts config on conflict", () => {
      db.insert(schema.standupConfig)
        .values({ telegramChatId: 123, promptHour: 9 })
        .run();

      db.insert(schema.standupConfig)
        .values({ telegramChatId: 123, promptHour: 10 })
        .onConflictDoUpdate({
          target: schema.standupConfig.telegramChatId,
          set: { promptHour: 10 },
        })
        .run();

      const results = db
        .select()
        .from(schema.standupConfig)
        .where(eq(schema.standupConfig.telegramChatId, 123))
        .all();

      expect(results).toHaveLength(1);
      expect(results[0]!.promptHour).toBe(10);
    });

    it("returns all configs", () => {
      db.insert(schema.standupConfig).values({ telegramChatId: 100 }).run();
      db.insert(schema.standupConfig).values({ telegramChatId: 200 }).run();

      const all = db.select().from(schema.standupConfig).all();
      expect(all).toHaveLength(2);
    });
  });

  describe("standupSessions", () => {
    it("creates a session and retrieves it", () => {
      db.insert(schema.standupSessions)
        .values({ telegramChatId: 123, date: "2026-02-18", status: "active" })
        .run();

      const results = db
        .select()
        .from(schema.standupSessions)
        .where(
          and(
            eq(schema.standupSessions.telegramChatId, 123),
            eq(schema.standupSessions.date, "2026-02-18")
          )
        )
        .all();

      expect(results).toHaveLength(1);
      expect(results[0]!.status).toBe("active");
    });

    it("enforces unique constraint on (chatId, date)", () => {
      db.insert(schema.standupSessions)
        .values({ telegramChatId: 123, date: "2026-02-18", status: "active" })
        .run();

      expect(() => {
        db.insert(schema.standupSessions)
          .values({ telegramChatId: 123, date: "2026-02-18", status: "active" })
          .run();
      }).toThrow();
    });

    it("allows same chat on different dates", () => {
      db.insert(schema.standupSessions)
        .values({ telegramChatId: 123, date: "2026-02-18", status: "active" })
        .run();
      db.insert(schema.standupSessions)
        .values({ telegramChatId: 123, date: "2026-02-19", status: "active" })
        .run();

      const all = db.select().from(schema.standupSessions).all();
      expect(all).toHaveLength(2);
    });

    it("updates session status and summary message ID", () => {
      db.insert(schema.standupSessions)
        .values({ telegramChatId: 123, date: "2026-02-18", status: "active" })
        .run();

      const session = db.select().from(schema.standupSessions).all()[0]!;

      db.update(schema.standupSessions)
        .set({ status: "summarized", summaryMessageId: 999 })
        .where(eq(schema.standupSessions.id, session.id))
        .run();

      const updated = db.select().from(schema.standupSessions).all()[0]!;
      expect(updated.status).toBe("summarized");
      expect(updated.summaryMessageId).toBe(999);
    });
  });

  describe("standupResponses", () => {
    let sessionId: number;

    beforeEach(() => {
      db.insert(schema.standupSessions)
        .values({ telegramChatId: 123, date: "2026-02-18", status: "active" })
        .run();
      sessionId = db.select().from(schema.standupSessions).all()[0]!.id;
    });

    it("inserts a response", () => {
      db.insert(schema.standupResponses)
        .values({
          sessionId,
          telegramUserId: 456,
          telegramUsername: "alice",
          yesterday: "Finished auth module",
          today: "Starting API tests",
          blockers: null,
          rawMessage: "Yesterday I finished the auth module, today I'm starting API tests",
        })
        .run();

      const results = db
        .select()
        .from(schema.standupResponses)
        .where(eq(schema.standupResponses.sessionId, sessionId))
        .all();

      expect(results).toHaveLength(1);
      expect(results[0]!.yesterday).toBe("Finished auth module");
      expect(results[0]!.today).toBe("Starting API tests");
      expect(results[0]!.blockers).toBeNull();
    });

    it("upserts response (latest wins)", () => {
      db.insert(schema.standupResponses)
        .values({
          sessionId,
          telegramUserId: 456,
          yesterday: "Old update",
          today: "Old plan",
        })
        .run();

      db.insert(schema.standupResponses)
        .values({
          sessionId,
          telegramUserId: 456,
          yesterday: "New update",
          today: "New plan",
          blockers: "Waiting on deploy",
        })
        .onConflictDoUpdate({
          target: [
            schema.standupResponses.sessionId,
            schema.standupResponses.telegramUserId,
          ],
          set: {
            yesterday: "New update",
            today: "New plan",
            blockers: "Waiting on deploy",
          },
        })
        .run();

      const results = db
        .select()
        .from(schema.standupResponses)
        .where(eq(schema.standupResponses.sessionId, sessionId))
        .all();

      expect(results).toHaveLength(1);
      expect(results[0]!.yesterday).toBe("New update");
      expect(results[0]!.today).toBe("New plan");
      expect(results[0]!.blockers).toBe("Waiting on deploy");
    });

    it("allows multiple users per session", () => {
      db.insert(schema.standupResponses)
        .values({ sessionId, telegramUserId: 100, yesterday: "A" })
        .run();
      db.insert(schema.standupResponses)
        .values({ sessionId, telegramUserId: 200, yesterday: "B" })
        .run();

      const results = db
        .select()
        .from(schema.standupResponses)
        .where(eq(schema.standupResponses.sessionId, sessionId))
        .all();

      expect(results).toHaveLength(2);
    });
  });
});
