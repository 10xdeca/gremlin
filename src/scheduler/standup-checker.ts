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
import { mcpManager } from "../agent/mcp-manager.js";

interface KanWorkspaceMember {
  publicId: string;
  email: string;
  role: string;
  status: string;
  user: { name: string | null } | null;
}

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

  // Nudge check: right hour + active session + not yet nudged → DM non-responders
  // Guard: skip if nudgeHour collides with promptHour (no responses yet) or summaryHour (wasted nudge)
  if (
    config.nudgeHour != null &&
    currentHour === config.nudgeHour &&
    config.nudgeHour !== config.promptHour &&
    config.nudgeHour !== config.summaryHour
  ) {
    const session = await getActiveStandupSession(telegramChatId, today);
    if (session && session.status === "active" && !session.nudgedAt) {
      await sendStandupNudges(bot, config, session);
    }
  }

  // Summary check: right hour + active session → summarize
  // Guard: don't summarize in the same hour as the prompt (no responses yet)
  if (currentHour === config.summaryHour && config.summaryHour !== config.promptHour) {
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

  // Get workspace link for thread ID and workspace scoping
  const wsLink = await getWorkspaceLink(telegramChatId);
  const messageThreadId = wsLink?.messageThreadId ?? undefined;

  // Scope @mentions to this workspace's members (not all user links globally)
  const { mentions, expectedUsernames: _ } = await getWorkspaceUsernames(wsLink?.workspacePublicId);

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

  // Gather responses and expected users (scoped to this workspace)
  const responses = await getStandupResponses(session.id);
  const { expectedUsernames } = await getWorkspaceUsernames(wsLink?.workspacePublicId);

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

async function sendStandupNudges(
  bot: Bot,
  config: StandupConfig,
  session: StandupSession
): Promise<void> {
  const { telegramChatId } = config;

  const wsLink = await getWorkspaceLink(telegramChatId);
  const { userLinks } = await getWorkspaceUsernames(wsLink?.workspacePublicId);

  const responses = await getStandupResponses(session.id);
  const respondedUserIds = new Set(responses.map((r) => r.telegramUserId));

  const missing = userLinks.filter((u) => !respondedUserIds.has(u.telegramUserId));

  if (missing.length === 0) {
    // Everyone responded — mark nudged so we don't re-check
    await updateStandupSession(session.id, { nudgedAt: Date.now() });
    return;
  }

  // Build a display name for the group chat
  const chatName = wsLink?.workspaceName
    ? escapeMarkdown(wsLink.workspaceName)
    : "the group chat";

  const nudgeMessage =
    `Standup reminder — you haven\\'t posted your update yet today\\.\n\n` +
    `Reply in ${chatName} with what you\\'re working on\\!`;

  let nudgedCount = 0;
  for (const user of missing) {
    try {
      await bot.api.sendMessage(user.telegramUserId, nudgeMessage, {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
      });
      nudgedCount++;
    } catch (error: unknown) {
      // 403 = user hasn't started a chat with the bot, skip silently
      const errorCode = (error as { error_code?: number })?.error_code;
      if (errorCode === 403) {
        console.log(
          `Nudge skipped for user ${user.telegramUserId} (@${user.telegramUsername}) — no DM chat`
        );
      } else {
        console.error(
          `Failed to nudge user ${user.telegramUserId} (@${user.telegramUsername}):`,
          error
        );
      }
    }
  }

  await updateStandupSession(session.id, { nudgedAt: Date.now() });
  console.log(
    `Sent standup nudges for chat ${telegramChatId} (${session.date}): ` +
      `${nudgedCount}/${missing.length} DMs sent`
  );
}

type UserLink = Awaited<ReturnType<typeof getAllUserLinks>>[number];

/**
 * Fetch workspace members via MCP and cross-reference with user links
 * to get Telegram usernames scoped to a specific workspace.
 */
async function getWorkspaceUsernames(workspacePublicId: string | undefined): Promise<{
  mentions: string;
  expectedUsernames: string[];
  userLinks: UserLink[];
}> {
  if (!workspacePublicId) {
    return { mentions: "", expectedUsernames: [], userLinks: [] };
  }

  try {
    const data = JSON.parse(
      await mcpManager.callTool("kan_get_workspace", { workspace_id: workspacePublicId })
    ) as { members?: KanWorkspaceMember[] };
    const members = data.members || [];
    const activeEmails = new Set(
      members.filter((m) => m.status === "active").map((m) => m.email.toLowerCase())
    );

    const allLinks = await getAllUserLinks();
    const workspaceUsers = allLinks.filter(
      (u) => u.telegramUsername && activeEmails.has(u.kanUserEmail.toLowerCase())
    );

    const usernames = workspaceUsers.map((u) => u.telegramUsername!);
    return {
      mentions: usernames.map((u) => `@${u}`).join(" "),
      expectedUsernames: usernames,
      userLinks: workspaceUsers,
    };
  } catch (error) {
    console.error(`Failed to fetch workspace members for ${workspacePublicId}:`, error);
    return { mentions: "", expectedUsernames: [], userLinks: [] };
  }
}

/** Escape MarkdownV2 special characters. */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*\[\]()~`>#+=|{}.!-]/g, "\\$&");
}
