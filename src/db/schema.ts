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

// Stores the bot's chosen identity after a naming ceremony
export const botIdentity = sqliteTable("bot_identity", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  pronouns: text("pronouns").notNull(),
  tone: text("tone").notNull(),
  toneDescription: text("tone_description"),
  chosenAt: integer("chosen_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  chosenInChatId: integer("chosen_in_chat_id"),
});

// Default board/list config for card creation per chat
export const defaultBoardConfig = sqliteTable("default_board_config", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  telegramChatId: integer("telegram_chat_id").notNull().unique(),
  boardPublicId: text("board_public_id").notNull(),
  listPublicId: text("list_public_id").notNull(),
  boardName: text("board_name").notNull(),
  listName: text("list_name").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Persists OAuth tokens (e.g. Claude refresh tokens) across restarts
export const oauthTokens = sqliteTable("oauth_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenType: text("token_type").notNull().unique(),
  tokenValue: text("token_value").notNull(),
  expiresAt: integer("expires_at"), // epoch ms, nullable
  updatedAt: integer("updated_at").notNull(),
});

// Per-chat standup configuration
export const standupConfig = sqliteTable("standup_config", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  telegramChatId: integer("telegram_chat_id").notNull().unique(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().$defaultFn(() => true),
  promptHour: integer("prompt_hour").notNull().$defaultFn(() => 9),
  summaryHour: integer("summary_hour").notNull().$defaultFn(() => 17),
  timezone: text("timezone").notNull().$defaultFn(() => "Australia/Sydney"),
  skipBreakDays: integer("skip_break_days", { mode: "boolean" }).notNull().$defaultFn(() => true),
  skipWeekends: integer("skip_weekends", { mode: "boolean" }).notNull().$defaultFn(() => true),
  nudgeHour: integer("nudge_hour"), // 0-23, nullable. If null, no nudges sent.
});

// One row per chat per day for standup sessions
export const standupSessions = sqliteTable("standup_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  telegramChatId: integer("telegram_chat_id").notNull(),
  date: text("date").notNull(), // "YYYY-MM-DD"
  promptMessageId: integer("prompt_message_id"),
  summaryMessageId: integer("summary_message_id"),
  status: text("status").notNull().$defaultFn(() => "active"), // active | summarized | skipped
  nudgedAt: integer("nudged_at"), // epoch ms timestamp when DM nudges were sent
}, (t) => [
  unique().on(t.telegramChatId, t.date),
]);

// Individual user standup responses
export const standupResponses = sqliteTable("standup_responses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  telegramUserId: integer("telegram_user_id").notNull(),
  telegramUsername: text("telegram_username"),
  yesterday: text("yesterday"),
  today: text("today"),
  blockers: text("blockers"),
  rawMessage: text("raw_message"),
}, (t) => [
  unique().on(t.sessionId, t.telegramUserId),
]);

// Tracks active/completed naming ceremonies
export const namingCeremonies = sqliteTable("naming_ceremonies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  telegramChatId: integer("telegram_chat_id").notNull(),
  messageThreadId: integer("message_thread_id"),
  pollMessageId: integer("poll_message_id"),
  options: text("options").notNull(), // JSON string of NamingOption[]
  status: text("status").notNull().default("active"), // active | concluded | cancelled
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  concludesAt: integer("concludes_at", { mode: "timestamp" }).notNull(),
  initiatedByUserId: integer("initiated_by_user_id").notNull(),
});
