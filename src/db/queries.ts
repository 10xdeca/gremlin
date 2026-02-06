import { eq, and, lt } from "drizzle-orm";
import { db, schema } from "./client.js";

// Workspace Links
export async function getWorkspaceLink(telegramChatId: number) {
  const results = db
    .select()
    .from(schema.telegramWorkspaceLinks)
    .where(eq(schema.telegramWorkspaceLinks.telegramChatId, telegramChatId))
    .all();
  return results[0] || null;
}

export async function createWorkspaceLink(data: {
  telegramChatId: number;
  workspacePublicId: string;
  workspaceName: string;
  messageThreadId?: number | null;
  createdByTelegramUserId: number;
}) {
  return db.insert(schema.telegramWorkspaceLinks).values(data).run();
}

export async function updateWorkspaceLinkTopic(telegramChatId: number, messageThreadId: number | null) {
  return db
    .update(schema.telegramWorkspaceLinks)
    .set({ messageThreadId })
    .where(eq(schema.telegramWorkspaceLinks.telegramChatId, telegramChatId))
    .run();
}

export async function deleteWorkspaceLink(telegramChatId: number) {
  return db
    .delete(schema.telegramWorkspaceLinks)
    .where(eq(schema.telegramWorkspaceLinks.telegramChatId, telegramChatId))
    .run();
}

export async function getAllWorkspaceLinks() {
  return db.select().from(schema.telegramWorkspaceLinks).all();
}

// User Links
export async function getUserLink(telegramUserId: number) {
  const results = db
    .select()
    .from(schema.telegramUserLinks)
    .where(eq(schema.telegramUserLinks.telegramUserId, telegramUserId))
    .all();
  return results[0] || null;
}

export async function createUserLink(data: {
  telegramUserId: number;
  telegramUsername?: string;
  kanUserEmail: string;
  workspaceMemberPublicId?: string;
  createdByTelegramUserId?: number;
}) {
  return db.insert(schema.telegramUserLinks).values(data).run();
}

export async function updateUserLink(
  telegramUserId: number,
  data: Partial<{
    telegramUsername: string;
    kanUserEmail: string;
    workspaceMemberPublicId: string;
  }>
) {
  return db
    .update(schema.telegramUserLinks)
    .set(data)
    .where(eq(schema.telegramUserLinks.telegramUserId, telegramUserId))
    .run();
}

export async function getUserLinkWithResolution(
  telegramUserId: number,
  telegramUsername?: string
) {
  // 1. Try by real user ID first
  let userLink = await getUserLink(telegramUserId);
  if (userLink) return userLink;

  // 2. Try by username if provided
  if (telegramUsername) {
    userLink = await getUserLinkByTelegramUsername(telegramUsername);
    if (userLink) {
      // 3. Update record with real user ID for future lookups
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

export async function getUserLinkByTelegramUsername(username: string) {
  const results = db
    .select()
    .from(schema.telegramUserLinks)
    .where(eq(schema.telegramUserLinks.telegramUsername, username))
    .all();
  return results[0] || null;
}

export async function deleteUserLink(telegramUserId: number) {
  return db
    .delete(schema.telegramUserLinks)
    .where(eq(schema.telegramUserLinks.telegramUserId, telegramUserId))
    .run();
}

export async function getAllUserLinks() {
  return db.select().from(schema.telegramUserLinks).all();
}

export async function getUserLinkByEmail(email: string) {
  const results = db
    .select()
    .from(schema.telegramUserLinks)
    .where(eq(schema.telegramUserLinks.kanUserEmail, email))
    .all();
  return results[0] || null;
}

// Reminders
export async function getLastReminder(
  cardPublicId: string,
  telegramChatId: number,
  reminderType: string = "overdue"
) {
  const results = db
    .select()
    .from(schema.telegramReminders)
    .where(
      and(
        eq(schema.telegramReminders.cardPublicId, cardPublicId),
        eq(schema.telegramReminders.telegramChatId, telegramChatId),
        eq(schema.telegramReminders.reminderType, reminderType)
      )
    )
    .all();
  return results[0] || null;
}

export async function upsertReminder(
  cardPublicId: string,
  telegramChatId: number,
  reminderType: string = "overdue"
) {
  return db
    .insert(schema.telegramReminders)
    .values({
      cardPublicId,
      telegramChatId,
      reminderType,
      lastReminderAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        schema.telegramReminders.cardPublicId,
        schema.telegramReminders.telegramChatId,
        schema.telegramReminders.reminderType,
      ],
      set: { lastReminderAt: new Date() },
    })
    .run();
}

export async function cleanOldReminders(olderThanDays: number = 7) {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

  return db
    .delete(schema.telegramReminders)
    .where(lt(schema.telegramReminders.lastReminderAt, cutoff))
    .run();
}
