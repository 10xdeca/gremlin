import { eq, and, lt, desc } from "drizzle-orm";
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

export async function getUserLinkByMemberPublicId(memberPublicId: string) {
  const results = db
    .select()
    .from(schema.telegramUserLinks)
    .where(eq(schema.telegramUserLinks.workspaceMemberPublicId, memberPublicId))
    .all();
  return results[0] || null;
}

// Default Board Config
export async function getDefaultBoardConfig(telegramChatId: number) {
  const results = db
    .select()
    .from(schema.defaultBoardConfig)
    .where(eq(schema.defaultBoardConfig.telegramChatId, telegramChatId))
    .all();
  return results[0] || null;
}

export async function upsertDefaultBoardConfig(data: {
  telegramChatId: number;
  boardPublicId: string;
  listPublicId: string;
  boardName: string;
  listName: string;
}) {
  return db
    .insert(schema.defaultBoardConfig)
    .values({ ...data, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.defaultBoardConfig.telegramChatId,
      set: {
        boardPublicId: data.boardPublicId,
        listPublicId: data.listPublicId,
        boardName: data.boardName,
        listName: data.listName,
        updatedAt: new Date(),
      },
    })
    .run();
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

// OAuth Tokens
export async function getOAuthToken(tokenType: string): Promise<string | null> {
  const results = db
    .select()
    .from(schema.oauthTokens)
    .where(eq(schema.oauthTokens.tokenType, tokenType))
    .all();
  return results[0]?.tokenValue ?? null;
}

export async function saveOAuthToken(
  tokenType: string,
  tokenValue: string,
  expiresAt?: number
): Promise<void> {
  db.insert(schema.oauthTokens)
    .values({
      tokenType,
      tokenValue,
      expiresAt: expiresAt ?? null,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: schema.oauthTokens.tokenType,
      set: {
        tokenValue,
        expiresAt: expiresAt ?? null,
        updatedAt: Date.now(),
      },
    })
    .run();
}

// Bot Identity
export async function getBotIdentityFromDb() {
  const results = db
    .select()
    .from(schema.botIdentity)
    .orderBy(desc(schema.botIdentity.chosenAt))
    .limit(1)
    .all();
  return results[0] || null;
}

export async function saveBotIdentity(data: {
  name: string;
  pronouns: string;
  tone: string;
  toneDescription: string | null;
  chosenInChatId: number | null;
}) {
  return db.insert(schema.botIdentity).values(data).run();
}

// Naming Ceremonies
export async function getActiveCeremony() {
  const results = db
    .select()
    .from(schema.namingCeremonies)
    .where(eq(schema.namingCeremonies.status, "active"))
    .all();
  return results[0] || null;
}

export async function createCeremony(data: {
  telegramChatId: number;
  messageThreadId: number | null;
  options: string;
  concludesAt: Date;
  initiatedByUserId: number;
}) {
  return db.insert(schema.namingCeremonies).values(data).run();
}

export async function updateCeremonyStatus(id: number, status: string) {
  return db
    .update(schema.namingCeremonies)
    .set({ status })
    .where(eq(schema.namingCeremonies.id, id))
    .run();
}

export async function updateCeremonyPollMessageId(id: number, pollMessageId: number) {
  return db
    .update(schema.namingCeremonies)
    .set({ pollMessageId })
    .where(eq(schema.namingCeremonies.id, id))
    .run();
}

export async function getExpiredCeremonies() {
  const now = new Date();
  const results = db
    .select()
    .from(schema.namingCeremonies)
    .where(
      and(
        eq(schema.namingCeremonies.status, "active"),
        lt(schema.namingCeremonies.concludesAt, now)
      )
    )
    .all();
  return results;
}

// Standup Config

export async function getStandupConfig(telegramChatId: number) {
  const results = db
    .select()
    .from(schema.standupConfig)
    .where(eq(schema.standupConfig.telegramChatId, telegramChatId))
    .all();
  return results[0] || null;
}

export async function upsertStandupConfig(data: {
  telegramChatId: number;
  enabled?: boolean;
  promptHour?: number;
  summaryHour?: number;
  timezone?: string;
  skipBreakDays?: boolean;
  skipWeekends?: boolean;
  nudgeHour?: number | null;
}) {
  return db
    .insert(schema.standupConfig)
    .values({
      telegramChatId: data.telegramChatId,
      enabled: data.enabled ?? true,
      promptHour: data.promptHour ?? 9,
      summaryHour: data.summaryHour ?? 17,
      timezone: data.timezone ?? "Australia/Sydney",
      skipBreakDays: data.skipBreakDays ?? true,
      skipWeekends: data.skipWeekends ?? true,
      nudgeHour: data.nudgeHour ?? null,
    })
    .onConflictDoUpdate({
      target: schema.standupConfig.telegramChatId,
      set: {
        ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
        ...(data.promptHour !== undefined ? { promptHour: data.promptHour } : {}),
        ...(data.summaryHour !== undefined ? { summaryHour: data.summaryHour } : {}),
        ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
        ...(data.skipBreakDays !== undefined ? { skipBreakDays: data.skipBreakDays } : {}),
        ...(data.skipWeekends !== undefined ? { skipWeekends: data.skipWeekends } : {}),
        ...(data.nudgeHour !== undefined ? { nudgeHour: data.nudgeHour } : {}),
      },
    })
    .run();
}

export async function getAllStandupConfigs() {
  return db.select().from(schema.standupConfig).all();
}

// Standup Sessions

export async function getActiveStandupSession(telegramChatId: number, date: string) {
  const results = db
    .select()
    .from(schema.standupSessions)
    .where(
      and(
        eq(schema.standupSessions.telegramChatId, telegramChatId),
        eq(schema.standupSessions.date, date)
      )
    )
    .all();
  return results[0] || null;
}

export async function createStandupSession(data: {
  telegramChatId: number;
  date: string;
  promptMessageId?: number | null;
  status?: string;
}) {
  return db
    .insert(schema.standupSessions)
    .values({
      telegramChatId: data.telegramChatId,
      date: data.date,
      promptMessageId: data.promptMessageId ?? null,
      status: data.status ?? "active",
    })
    .run();
}

export async function updateStandupSession(
  id: number,
  data: Partial<{
    promptMessageId: number | null;
    summaryMessageId: number | null;
    status: string;
    nudgedAt: number | null;
  }>
) {
  return db
    .update(schema.standupSessions)
    .set(data)
    .where(eq(schema.standupSessions.id, id))
    .run();
}

// Standup Responses

export async function upsertStandupResponse(data: {
  sessionId: number;
  telegramUserId: number;
  telegramUsername?: string | null;
  yesterday?: string | null;
  today?: string | null;
  blockers?: string | null;
  rawMessage?: string | null;
}) {
  return db
    .insert(schema.standupResponses)
    .values({
      sessionId: data.sessionId,
      telegramUserId: data.telegramUserId,
      telegramUsername: data.telegramUsername ?? null,
      yesterday: data.yesterday ?? null,
      today: data.today ?? null,
      blockers: data.blockers ?? null,
      rawMessage: data.rawMessage ?? null,
    })
    .onConflictDoUpdate({
      target: [
        schema.standupResponses.sessionId,
        schema.standupResponses.telegramUserId,
      ],
      set: {
        telegramUsername: data.telegramUsername ?? null,
        yesterday: data.yesterday ?? null,
        today: data.today ?? null,
        blockers: data.blockers ?? null,
        rawMessage: data.rawMessage ?? null,
      },
    })
    .run();
}

export async function getStandupResponses(sessionId: number) {
  return db
    .select()
    .from(schema.standupResponses)
    .where(eq(schema.standupResponses.sessionId, sessionId))
    .all();
}

// Calendar Reminders

export async function hasCalendarReminderBeenSent(
  eventUid: string,
  telegramChatId: number,
  reminderWindow: string,
): Promise<boolean> {
  const results = db
    .select()
    .from(schema.calendarReminders)
    .where(
      and(
        eq(schema.calendarReminders.eventUid, eventUid),
        eq(schema.calendarReminders.telegramChatId, telegramChatId),
        eq(schema.calendarReminders.reminderWindow, reminderWindow),
      ),
    )
    .all();
  return results.length > 0;
}

export async function recordCalendarReminder(
  eventUid: string,
  telegramChatId: number,
  reminderWindow: string,
): Promise<void> {
  db.insert(schema.calendarReminders)
    .values({
      eventUid,
      telegramChatId,
      reminderWindow,
      sentAt: new Date(),
    })
    .onConflictDoNothing()
    .run();
}

export async function cleanOldCalendarReminders(daysOld: number = 7): Promise<void> {
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  db.delete(schema.calendarReminders)
    .where(lt(schema.calendarReminders.sentAt, cutoff))
    .run();
}
