import cron from "node-cron";
import type { Bot } from "grammy";
import { getServiceClient, type KanCard, type KanBoard, type KanList, type KanApiClient } from "../api/kan-client.js";
import {
  getAllWorkspaceLinks,
  getAllUserLinks,
  getLastReminder,
  upsertReminder,
  cleanOldReminders,
} from "../db/queries.js";
import {
  formatOverdueReminder,
  formatNoDueDateReminder,
  formatVagueTaskReminder,
  formatStaleTaskReminder,
  formatUnassignedReminders,
  formatNoTasksReminder,
} from "../utils/format.js";
import { evaluateTaskVagueness } from "../services/vagueness-evaluator.js";
import { isSprintPlanningWindow, getSprintInfo } from "../utils/sprint.js";
import type { ReminderType } from "../db/schema.js";

const REMINDER_INTERVAL_HOURS = parseInt(
  process.env.REMINDER_INTERVAL_HOURS || "1",
  10
);

// Minimum hours between reminders for each type
const MIN_HOURS_BETWEEN_REMINDERS: Record<ReminderType, number> = {
  overdue: 24,
  no_due_date: 24,  // Only runs in planning window anyway
  vague: 24,        // Only runs in planning window anyway
  stale: 48,
  unassigned: 48,
  no_tasks: 24,     // Only runs in planning window anyway
};

type UserLinkMap = Map<
  string,
  { telegramUserId: number; telegramUsername: string | null }
>;

type UserLink = {
  telegramUserId: number;
  telegramUsername: string | null;
  kanUserEmail: string;
};

type WorkspaceLink = {
  telegramChatId: number;
  workspacePublicId: string;
  workspaceName: string;
  messageThreadId: number | null;
};

export function startTaskChecker(bot: Bot) {
  // Run every hour at minute 0
  const cronExpression = `0 */${REMINDER_INTERVAL_HOURS} * * *`;

  console.log(
    `Starting task checker with schedule: ${cronExpression} (every ${REMINDER_INTERVAL_HOURS} hour(s))`
  );

  cron.schedule(cronExpression, async () => {
    console.log("Running task check...");
    await checkAllTaskIssues(bot);
  });

  // Also clean old reminders daily at 3am
  cron.schedule("0 3 * * *", async () => {
    console.log("Cleaning old reminders...");
    await cleanOldReminders(7);
  });

  // Run once on startup after a short delay
  setTimeout(() => {
    console.log("Running initial task check...");
    checkAllTaskIssues(bot);
  }, 5000);
}

async function checkAllTaskIssues(bot: Bot) {
  try {
    const workspaceLinks = await getAllWorkspaceLinks();
    const userLinks = await getAllUserLinks();

    if (workspaceLinks.length === 0) {
      console.log("No workspace links configured, skipping check.");
      return;
    }

    // Build a map of user links by email for quick lookup
    const userLinksByEmail: UserLinkMap = new Map();
    for (const link of userLinks) {
      userLinksByEmail.set(link.kanUserEmail.toLowerCase(), {
        telegramUserId: link.telegramUserId,
        telegramUsername: link.telegramUsername,
      });
    }

    for (const workspaceLink of workspaceLinks) {
      await processWorkspace(bot, workspaceLink, userLinksByEmail);
    }
  } catch (error) {
    console.error("Error in task checker:", error);
  }
}

async function processWorkspace(
  bot: Bot,
  workspaceLink: WorkspaceLink,
  userLinksByEmail: UserLinkMap
) {
  // Use the service client
  let client;
  let workspaceSlug = "";

  try {
    client = getServiceClient();
    const workspace = await client.getWorkspace(workspaceLink.workspacePublicId);
    workspaceSlug = workspace.slug;
  } catch (error) {
    console.log(
      `Cannot access workspace ${workspaceLink.workspaceName}: ${error}`
    );
    return;
  }

  // Check if we're in sprint planning window (days 1-2)
  const inPlanningWindow = isSprintPlanningWindow();
  const sprintInfo = getSprintInfo();
  console.log(`Sprint day ${sprintInfo.day}, planning window: ${inPlanningWindow}`);

  // Build list of checks to run
  const checks: Promise<void>[] = [
    // Always check overdue and stale tasks
    checkOverdueTasks(bot, client, workspaceLink, workspaceSlug, userLinksByEmail),
    checkStaleTasks(bot, client, workspaceLink, workspaceSlug, userLinksByEmail),
    checkUnassignedTasks(bot, client, workspaceLink, workspaceSlug, userLinksByEmail),
  ];

  // Only nag about vagueness, missing due dates, and missing tasks in sprint planning window
  if (inPlanningWindow) {
    checks.push(
      checkNoDueDates(bot, client, workspaceLink, workspaceSlug, userLinksByEmail),
      checkVagueTasks(bot, client, workspaceLink, workspaceSlug, userLinksByEmail),
      checkNoTasks(bot, client, workspaceLink, workspaceSlug, userLinksByEmail)
    );
  }

  await Promise.all(checks);
}

function getAssigneeUsernames(
  card: KanCard,
  userLinksByEmail: UserLinkMap
): string[] {
  const assigneeUsernames: string[] = [];
  if (card.members) {
    for (const member of card.members) {
      const userLink = userLinksByEmail.get(member.email.toLowerCase());
      if (userLink?.telegramUsername) {
        assigneeUsernames.push(userLink.telegramUsername);
      }
    }
  }
  return assigneeUsernames;
}

async function shouldSendReminder(
  cardPublicId: string,
  chatId: number,
  reminderType: ReminderType
): Promise<boolean> {
  const lastReminder = await getLastReminder(cardPublicId, chatId, reminderType);
  if (!lastReminder) return true;

  const hoursSinceReminder =
    (Date.now() - lastReminder.lastReminderAt.getTime()) / (1000 * 60 * 60);
  return hoursSinceReminder >= MIN_HOURS_BETWEEN_REMINDERS[reminderType];
}

async function sendReminderMessage(
  bot: Bot,
  chatId: number,
  cardPublicId: string,
  reminderType: ReminderType,
  message: string,
  cardTitle: string,
  messageThreadId?: number | null
): Promise<void> {
  try {
    await bot.api.sendMessage(chatId, message, {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    });

    await upsertReminder(cardPublicId, chatId, reminderType);

    console.log(
      `Sent ${reminderType} reminder for "${cardTitle}" to chat ${chatId}`
    );
  } catch (error) {
    console.error(
      `Failed to send ${reminderType} reminder to chat ${chatId}:`,
      error
    );
  }
}

// Check for overdue tasks
async function checkOverdueTasks(
  bot: Bot,
  client: KanApiClient,
  workspaceLink: WorkspaceLink,
  workspaceSlug: string,
  userLinksByEmail: UserLinkMap
) {
  try {
    const overdueTasks = await client.getOverdueCards(
      workspaceLink.workspacePublicId
    );

    for (const { card, board, list } of overdueTasks) {
      if (!(await shouldSendReminder(card.publicId, workspaceLink.telegramChatId, "overdue"))) {
        continue;
      }

      const assigneeUsernames = getAssigneeUsernames(card, userLinksByEmail);
      const message = formatOverdueReminder(
        card,
        board,
        list,
        assigneeUsernames,
        workspaceSlug
      );

      await sendReminderMessage(
        bot,
        workspaceLink.telegramChatId,
        card.publicId,
        "overdue",
        message,
        card.title,
        workspaceLink.messageThreadId
      );
    }
  } catch (error) {
    console.error(
      `Error checking overdue tasks for workspace ${workspaceLink.workspaceName}:`,
      error
    );
  }
}

// Check for tasks without due dates
async function checkNoDueDates(
  bot: Bot,
  client: KanApiClient,
  workspaceLink: WorkspaceLink,
  workspaceSlug: string,
  userLinksByEmail: UserLinkMap
) {
  try {
    const tasks = await client.getCardsWithoutDueDate(
      workspaceLink.workspacePublicId
    );

    for (const { card, board, list } of tasks) {
      if (!(await shouldSendReminder(card.publicId, workspaceLink.telegramChatId, "no_due_date"))) {
        continue;
      }

      const assigneeUsernames = getAssigneeUsernames(card, userLinksByEmail);
      const message = formatNoDueDateReminder(
        card,
        board,
        list,
        assigneeUsernames,
        workspaceSlug
      );

      await sendReminderMessage(
        bot,
        workspaceLink.telegramChatId,
        card.publicId,
        "no_due_date",
        message,
        card.title,
        workspaceLink.messageThreadId
      );
    }
  } catch (error) {
    console.error(
      `Error checking no-due-date tasks for workspace ${workspaceLink.workspaceName}:`,
      error
    );
  }
}

// Check for vague tasks using LLM evaluation
async function checkVagueTasks(
  bot: Bot,
  client: KanApiClient,
  workspaceLink: WorkspaceLink,
  workspaceSlug: string,
  userLinksByEmail: UserLinkMap
) {
  try {
    const candidates = await client.getVagueTaskCandidates(workspaceLink.workspacePublicId);

    for (const { card, board, list } of candidates) {
      if (!(await shouldSendReminder(card.publicId, workspaceLink.telegramChatId, "vague"))) {
        continue;
      }

      // Use LLM to evaluate if the task is actually vague
      const evaluation = await evaluateTaskVagueness({
        title: card.title,
        description: card.description,
        listName: list.name,
      });

      if (!evaluation.isVague) {
        continue;
      }

      const assigneeUsernames = getAssigneeUsernames(card, userLinksByEmail);
      const message = formatVagueTaskReminder(
        card,
        board,
        list,
        assigneeUsernames,
        workspaceSlug,
        evaluation.reason
      );

      await sendReminderMessage(
        bot,
        workspaceLink.telegramChatId,
        card.publicId,
        "vague",
        message,
        card.title,
        workspaceLink.messageThreadId
      );
    }
  } catch (error) {
    console.error(
      `Error checking vague tasks for workspace ${workspaceLink.workspaceName}:`,
      error
    );
  }
}

// Check for stale tasks (in progress too long)
async function checkStaleTasks(
  bot: Bot,
  client: KanApiClient,
  workspaceLink: WorkspaceLink,
  workspaceSlug: string,
  userLinksByEmail: UserLinkMap
) {
  try {
    const tasks = await client.getStaleTasks(workspaceLink.workspacePublicId);

    for (const { card, board, list, daysInList } of tasks) {
      if (!(await shouldSendReminder(card.publicId, workspaceLink.telegramChatId, "stale"))) {
        continue;
      }

      const assigneeUsernames = getAssigneeUsernames(card, userLinksByEmail);
      const message = formatStaleTaskReminder(
        card,
        board,
        list,
        assigneeUsernames,
        workspaceSlug,
        daysInList
      );

      await sendReminderMessage(
        bot,
        workspaceLink.telegramChatId,
        card.publicId,
        "stale",
        message,
        card.title,
        workspaceLink.messageThreadId
      );
    }
  } catch (error) {
    console.error(
      `Error checking stale tasks for workspace ${workspaceLink.workspaceName}:`,
      error
    );
  }
}

// Check for unassigned tasks
async function checkUnassignedTasks(
  bot: Bot,
  client: KanApiClient,
  workspaceLink: WorkspaceLink,
  workspaceSlug: string,
  userLinksByEmail: UserLinkMap
) {
  try {
    const tasks = await client.getUnassignedTasks(
      workspaceLink.workspacePublicId
    );

    // Filter to tasks that need a reminder
    const tasksToRemind: Array<{
      card: KanCard;
      board: KanBoard;
      list: KanList;
      creatorUsername?: string | null;
    }> = [];

    for (const { card, board, list } of tasks) {
      if (!(await shouldSendReminder(card.publicId, workspaceLink.telegramChatId, "unassigned"))) {
        continue;
      }

      let creatorUsername: string | null = null;
      if (card.createdBy?.email) {
        const creatorLink = userLinksByEmail.get(card.createdBy.email.toLowerCase());
        creatorUsername = creatorLink?.telegramUsername ?? null;
      }

      tasksToRemind.push({ card, board, list, creatorUsername });
    }

    if (tasksToRemind.length === 0) return;

    const message = formatUnassignedReminders(tasksToRemind);

    try {
      await bot.api.sendMessage(workspaceLink.telegramChatId, message, {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
        ...(workspaceLink.messageThreadId ? { message_thread_id: workspaceLink.messageThreadId } : {}),
      });

      // Record reminders for all cards in the batch
      for (const { card } of tasksToRemind) {
        await upsertReminder(card.publicId, workspaceLink.telegramChatId, "unassigned");
      }

      console.log(
        `Sent unassigned reminder for ${tasksToRemind.length} tasks to chat ${workspaceLink.telegramChatId}`
      );
    } catch (error) {
      console.error(
        `Failed to send unassigned reminder to chat ${workspaceLink.telegramChatId}:`,
        error
      );
    }
  } catch (error) {
    console.error(
      `Error checking unassigned tasks for workspace ${workspaceLink.workspaceName}:`,
      error
    );
  }
}

// Check for workspace members with no tasks assigned
async function checkNoTasks(
  bot: Bot,
  client: KanApiClient,
  workspaceLink: WorkspaceLink,
  workspaceSlug: string,
  userLinksByEmail: UserLinkMap
) {
  try {
    const membersWithNoTasks = await client.getMembersWithNoTasks(
      workspaceLink.workspacePublicId
    );

    for (const member of membersWithNoTasks) {
      // Use a synthetic ID for tracking reminders per user
      const syntheticId = `no_tasks:${member.publicId}`;

      if (!(await shouldSendReminder(syntheticId, workspaceLink.telegramChatId, "no_tasks"))) {
        continue;
      }

      // Find telegram username for this member
      const userLink = userLinksByEmail.get(member.email.toLowerCase());

      // Only nag users who are linked to Telegram (so they can see the message)
      if (!userLink?.telegramUsername) {
        continue;
      }

      const message = formatNoTasksReminder(
        userLink.telegramUsername,
        member.user?.name || null,
        workspaceSlug
      );

      await sendReminderMessage(
        bot,
        workspaceLink.telegramChatId,
        syntheticId,
        "no_tasks",
        message,
        `no tasks for ${member.email}`,
        workspaceLink.messageThreadId
      );
    }
  } catch (error) {
    console.error(
      `Error checking members with no tasks for workspace ${workspaceLink.workspaceName}:`,
      error
    );
  }
}

// Re-export for backwards compatibility
export { startTaskChecker as startOverdueChecker };
