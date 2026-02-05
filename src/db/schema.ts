import { sqliteTable, text, integer, unique } from "drizzle-orm/sqlite-core";

// Links a Telegram group chat to a Kan workspace
export const telegramWorkspaceLinks = sqliteTable("telegram_workspace_links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  telegramChatId: integer("telegram_chat_id").notNull().unique(),
  workspacePublicId: text("workspace_public_id").notNull(),
  workspaceName: text("workspace_name").notNull(),
  messageThreadId: integer("message_thread_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  createdByTelegramUserId: integer("created_by_telegram_user_id").notNull(),
});

// Links a Telegram user to their Kan account (mapped by admin)
export const telegramUserLinks = sqliteTable("telegram_user_links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  telegramUserId: integer("telegram_user_id").notNull().unique(),
  telegramUsername: text("telegram_username"),
  kanUserEmail: text("kan_user_email").notNull(),
  workspaceMemberPublicId: text("workspace_member_public_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  createdByTelegramUserId: integer("created_by_telegram_user_id"), // Admin who created the mapping
});

// Tracks reminders sent to avoid spamming
export const telegramReminders = sqliteTable("telegram_reminders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cardPublicId: text("card_public_id").notNull(),
  telegramChatId: integer("telegram_chat_id").notNull(),
  reminderType: text("reminder_type").notNull().default("overdue"),
  lastReminderAt: integer("last_reminder_at", { mode: "timestamp" }).notNull(),
}, (t) => [
  unique().on(t.cardPublicId, t.telegramChatId, t.reminderType),
]);

// Valid reminder types
export type ReminderType = "overdue" | "no_due_date" | "vague" | "stale" | "unassigned" | "no_tasks";
