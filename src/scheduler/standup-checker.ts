import cron from "node-cron";
import type { Bot } from "grammy";
import {
  getAllStandupConfigs,
  getActiveStandupSession,
  createStandupSession,
  updateStandupSession,
  getStandupResponses,
  getAllUserLinks,
  getWorkspaceLink,
} from "../db/queries.js";
import {
  getTodayInTimezone,
  getCurrentHourInTimezone,
  isWeekendInTimezone,
} from "../utils/timezone.js";
import { isBreakDay } from "../utils/sprint.js";
import { formatStandupSummary } from "../services/standup-summarizer.js";

/**
 * Start the standup scheduler. Runs every 5 minutes, checks each configured
 * chat for prompt and summary timing.
 */
export function startStandupChecker(bot: Bot): void {
  console.log("Starting standup checker (every 5 minutes)");

  cron.schedule("*/5 * * * *", async () => {
    await checkAllStandups(bot);
  });
}

async function checkAllStandups(bot: Bot): Promise<void> {
  try {
    const configs = await getAllStandupConfigs();
    if (configs.length === 0) return;

    for (const config of configs) {
      if (!config.enabled) continue;

      try {
        await processStandupConfig(bot, config);
      } catch (error) {
        console.error(
          `Error processing standup for chat ${config.telegramChatId}:`,
          error
        );
      }
    }
  } catch (error) {
    console.error("Error in standup checker:", error);
  }
}

type StandupConfig = Awaited<ReturnType<typeof getAllStandupConfigs>>[number];

async function processStandupConfig(bot: Bot, config: StandupConfig): Promise<void> {
  const now = new Date();
  const { timezone, telegramChatId } = config;

  // Skip conditions
  if (config.skipBreakDays && isBreakDay(now)) return;
  if (config.skipWeekends && isWeekendInTimezone(timezone, now)) return;

  const today = getTodayInTimezone(timezone, now);
  const currentHour = getCurrentHourInTimezone(timezone, now);

  // Prompt check: right hour + no session yet → create session and send prompt
  if (currentHour === config.promptHour) {
    const existing = await getActiveStandupSession(telegramChatId, today);
    if (!existing) {
      await sendStandupPrompt(bot, config, today);
    }
  }

  // Summary check: right hour + active session → summarize
  if (currentHour === config.summaryHour) {
    const session = await getActiveStandupSession(telegramChatId, today);
    if (session && session.status === "active") {
      await sendStandupSummary(bot, config, session);
    }
  }
}

async function sendStandupPrompt(
  bot: Bot,
  config: StandupConfig,
  today: string
): Promise<void> {
  const { telegramChatId } = config;

  // Get workspace link for thread ID
  const wsLink = await getWorkspaceLink(telegramChatId);
  const messageThreadId = wsLink?.messageThreadId ?? undefined;

  // Get all mapped users for @mentions
  const userLinks = await getAllUserLinks();
  const mentions = userLinks
    .filter((u) => u.telegramUsername)
    .map((u) => `@${u.telegramUsername}`)
    .join(" ");

  const message =
    `*Daily Standup* — ${escapeMarkdown(today)}\n\n` +
    `Share your update:\n` +
    `• What did you work on yesterday?\n` +
    `• What are you working on today?\n` +
    `• Any blockers?\n\n` +
    `Reply to this message with your update\\.\n\n` +
    (mentions ? mentions : "");

  try {
    const sent = await bot.api.sendMessage(telegramChatId, message, {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    });

    // Create the session with the prompt message ID
    await createStandupSession({
      telegramChatId,
      date: today,
      promptMessageId: sent.message_id,
      status: "active",
    });

    console.log(`Sent standup prompt for chat ${telegramChatId} (${today})`);
  } catch (error) {
    console.error(`Failed to send standup prompt for chat ${telegramChatId}:`, error);
  }
}

type StandupSession = NonNullable<Awaited<ReturnType<typeof getActiveStandupSession>>>;

async function sendStandupSummary(
  bot: Bot,
  config: StandupConfig,
  session: StandupSession
): Promise<void> {
  const { telegramChatId } = config;

  // Get workspace link for thread ID
  const wsLink = await getWorkspaceLink(telegramChatId);
  const messageThreadId = wsLink?.messageThreadId ?? undefined;

  // Gather responses and expected users
  const responses = await getStandupResponses(session.id);
  const userLinks = await getAllUserLinks();
  const expectedUsernames = userLinks
    .filter((u) => u.telegramUsername)
    .map((u) => u.telegramUsername!);

  const summary = formatStandupSummary({
    date: session.date,
    responses: responses.map((r) => ({
      telegramUserId: r.telegramUserId,
      telegramUsername: r.telegramUsername,
      yesterday: r.yesterday,
      today: r.today,
      blockers: r.blockers,
    })),
    expectedUsernames,
  });

  try {
    const sent = await bot.api.sendMessage(telegramChatId, summary, {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      // Reply to the prompt message for threading
      ...(session.promptMessageId
        ? { reply_to_message_id: session.promptMessageId }
        : {}),
    });

    await updateStandupSession(session.id, {
      status: "summarized",
      summaryMessageId: sent.message_id,
    });

    console.log(`Sent standup summary for chat ${telegramChatId} (${session.date})`);
  } catch (error) {
    console.error(`Failed to send standup summary for chat ${telegramChatId}:`, error);
  }
}

/** Escape MarkdownV2 special characters. */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*\[\]()~`>#+=|{}.!-]/g, "\\$&");
}
