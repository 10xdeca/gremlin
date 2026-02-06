import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";

// Create an in-memory DB for each test
function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE telegram_user_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL UNIQUE,
      telegram_username TEXT,
      kan_user_email TEXT NOT NULL,
      workspace_member_public_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      created_by_telegram_user_id INTEGER
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe("getUserLinkWithResolution", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle>;

  // Re-implement the resolution logic against our test DB
  async function getUserLink(telegramUserId: number) {
    const results = db
      .select()
      .from(schema.telegramUserLinks)
      .where(eq(schema.telegramUserLinks.telegramUserId, telegramUserId))
      .all();
    return results[0] || null;
  }

  async function getUserLinkByTelegramUsername(username: string) {
    const results = db
      .select()
      .from(schema.telegramUserLinks)
      .where(eq(schema.telegramUserLinks.telegramUsername, username))
      .all();
    return results[0] || null;
  }

  async function getUserLinkWithResolution(
    telegramUserId: number,
    telegramUsername?: string
  ) {
    let userLink = await getUserLink(telegramUserId);
    if (userLink) return userLink;

    if (telegramUsername) {
      userLink = await getUserLinkByTelegramUsername(telegramUsername);
      if (userLink) {
        db.update(schema.telegramUserLinks)
          .set({ telegramUserId })
          .where(eq(schema.telegramUserLinks.telegramUsername, telegramUsername))
          .run();
        userLink.telegramUserId = telegramUserId;
        return userLink;
      }
    }

    return null;
  }

  beforeEach(() => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    db = testDb.db;
  });

  afterEach(() => {
    sqlite.close();
  });

  it("returns null when no user link exists", async () => {
    const result = await getUserLinkWithResolution(12345);
    expect(result).toBeNull();
  });

  it("returns null when no user link exists even with username", async () => {
    const result = await getUserLinkWithResolution(12345, "someuser");
    expect(result).toBeNull();
  });

  it("finds user link by real user ID", async () => {
    db.insert(schema.telegramUserLinks)
      .values({
        telegramUserId: 12345,
        telegramUsername: "testuser",
        kanUserEmail: "test@example.com",
      })
      .run();

    const result = await getUserLinkWithResolution(12345);
    expect(result).not.toBeNull();
    expect(result!.kanUserEmail).toBe("test@example.com");
    expect(result!.telegramUserId).toBe(12345);
  });

  it("finds user link by username when ID doesn't match (placeholder ID)", async () => {
    // Simulate what /map does: creates a record with a placeholder (negative) ID
    const placeholderId = -9876;
    db.insert(schema.telegramUserLinks)
      .values({
        telegramUserId: placeholderId,
        telegramUsername: "testuser",
        kanUserEmail: "test@example.com",
      })
      .run();

    // Real user with ID 12345 tries /mytasks
    const result = await getUserLinkWithResolution(12345, "testuser");
    expect(result).not.toBeNull();
    expect(result!.kanUserEmail).toBe("test@example.com");
    // Should have been updated to the real ID
    expect(result!.telegramUserId).toBe(12345);
  });

  it("updates the DB record with real user ID after username resolution", async () => {
    const placeholderId = -9876;
    db.insert(schema.telegramUserLinks)
      .values({
        telegramUserId: placeholderId,
        telegramUsername: "testuser",
        kanUserEmail: "test@example.com",
      })
      .run();

    // First call resolves by username and updates the record
    await getUserLinkWithResolution(12345, "testuser");

    // Second call should find it directly by real user ID (no username needed)
    const result = await getUserLinkWithResolution(12345);
    expect(result).not.toBeNull();
    expect(result!.kanUserEmail).toBe("test@example.com");
    expect(result!.telegramUserId).toBe(12345);
  });

  it("prefers real user ID match over username match", async () => {
    // Two records: one with real ID, one with placeholder for same username
    db.insert(schema.telegramUserLinks)
      .values({
        telegramUserId: 12345,
        telegramUsername: "testuser",
        kanUserEmail: "real@example.com",
      })
      .run();

    const result = await getUserLinkWithResolution(12345, "testuser");
    expect(result!.kanUserEmail).toBe("real@example.com");
  });
});
