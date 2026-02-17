import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import * as schema from "./schema.js";

const dbPath = process.env.DATABASE_PATH || "./data/kan-bot.db";

// Ensure directory exists
mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);
export const db = drizzle(sqlite, { schema });

// Initialize tables
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS telegram_workspace_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_chat_id INTEGER NOT NULL UNIQUE,
    workspace_public_id TEXT NOT NULL,
    workspace_name TEXT NOT NULL,
    message_thread_id INTEGER,
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

  CREATE TABLE IF NOT EXISTS telegram_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_public_id TEXT NOT NULL,
    telegram_chat_id INTEGER NOT NULL,
    reminder_type TEXT NOT NULL DEFAULT 'overdue',
    last_reminder_at INTEGER NOT NULL,
    UNIQUE(card_public_id, telegram_chat_id, reminder_type)
  );
`);

// Migration: Add reminder_type column to existing databases
try {
  sqlite.exec(`ALTER TABLE telegram_reminders ADD COLUMN reminder_type TEXT NOT NULL DEFAULT 'overdue'`);
  console.log("Migration: Added reminder_type column to telegram_reminders");
} catch {
  // Column already exists, ignore
}

// Migration: Add created_by_telegram_user_id column to telegram_user_links
try {
  sqlite.exec(`ALTER TABLE telegram_user_links ADD COLUMN created_by_telegram_user_id INTEGER`);
  console.log("Migration: Added created_by_telegram_user_id column to telegram_user_links");
} catch {
  // Column already exists, ignore
}

// Migration: Remove kan_api_key column (recreate table without it)
try {
  const hasOldColumn = sqlite.prepare(`SELECT kan_api_key FROM telegram_user_links LIMIT 1`).get();
  // If we get here, old column exists - recreate table
  sqlite.exec(`
    ALTER TABLE telegram_user_links RENAME TO telegram_user_links_old;
    CREATE TABLE telegram_user_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL UNIQUE,
      telegram_username TEXT,
      kan_user_email TEXT NOT NULL,
      workspace_member_public_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      created_by_telegram_user_id INTEGER
    );
    INSERT INTO telegram_user_links (id, telegram_user_id, telegram_username, kan_user_email, workspace_member_public_id, created_at)
      SELECT id, telegram_user_id, telegram_username, kan_user_email, workspace_member_public_id, created_at
      FROM telegram_user_links_old;
    DROP TABLE telegram_user_links_old;
  `);
  console.log("Migration: Removed kan_api_key column from telegram_user_links");
} catch {
  // Column doesn't exist or migration already done
}

// Migration: Add UNIQUE constraint to telegram_reminders (dedupe existing rows)
try {
  // Check if the unique constraint already exists by trying to find duplicates
  const dupes = sqlite.prepare(`
    SELECT card_public_id, telegram_chat_id, reminder_type, COUNT(*) as cnt
    FROM telegram_reminders
    GROUP BY card_public_id, telegram_chat_id, reminder_type
    HAVING cnt > 1
  `).all();

  if ((dupes as any[]).length > 0 || !hasUniqueConstraint()) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS telegram_reminders_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_public_id TEXT NOT NULL,
        telegram_chat_id INTEGER NOT NULL,
        reminder_type TEXT NOT NULL DEFAULT 'overdue',
        last_reminder_at INTEGER NOT NULL,
        UNIQUE(card_public_id, telegram_chat_id, reminder_type)
      );
      INSERT OR REPLACE INTO telegram_reminders_new (card_public_id, telegram_chat_id, reminder_type, last_reminder_at)
        SELECT card_public_id, telegram_chat_id, reminder_type, MAX(last_reminder_at)
        FROM telegram_reminders
        GROUP BY card_public_id, telegram_chat_id, reminder_type;
      DROP TABLE telegram_reminders;
      ALTER TABLE telegram_reminders_new RENAME TO telegram_reminders;
    `);
    console.log("Migration: Added UNIQUE constraint to telegram_reminders (deduped existing rows)");
  }
} catch {
  // Table may not exist yet or migration already done
}

function hasUniqueConstraint(): boolean {
  try {
    const tableInfo = sqlite.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='telegram_reminders'`).get() as { sql: string } | undefined;
    return tableInfo?.sql?.includes("UNIQUE") ?? false;
  } catch {
    return false;
  }
}

// Migration: Add message_thread_id column to telegram_workspace_links
try {
  sqlite.exec(`ALTER TABLE telegram_workspace_links ADD COLUMN message_thread_id INTEGER`);
  console.log("Migration: Added message_thread_id column to telegram_workspace_links");
} catch {
  // Column already exists, ignore
}

export { schema };
