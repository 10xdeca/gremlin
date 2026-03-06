import cron from "node-cron";
import type { Bot } from "grammy";
import { runAgentLoop } from "../agent/agent-loop.js";
import { mcpManager } from "../agent/mcp-manager.js";
import {
  getAllWorkspaceLinks,
  getAllUserLinks,
  getLastReminder,
  upsertReminder,
  cleanOldReminders,
} from "../db/queries.js";
import { evaluateTaskVagueness } from "../services/vagueness-evaluator.js";
import { isSprintPlanningWindow, getSprintInfo } from "../utils/sprint.js";
import { handleUnreachableChat } from "../utils/telegram.js";
import type { ReminderType } from "../db/schema.js";

const REMINDER_INTERVAL_HOURS = parseInt(
  process.env.REMINDER_INTERVAL_HOURS || "1",
  10
);

const KAN_BASE_URL = (process.env.KAN_BASE_URL || "https://tasks.xdeca.com/api/v1")
  .replace(/\/api\/v1$/, "");

// Minimum hours between reminders for each type
const MIN_HOURS_BETWEEN_REMINDERS: Record<ReminderType, number> = {
  overdue: 24,
  no_due_date: 24,
  vague: 24,
  stale: 48,
  unassigned: 48,
  no_tasks: 24,
};

// Lightweight types for Kan data parsed from MCP tool responses
interface KanCard {
  publicId: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  members?: Array<{ publicId: string; email: string; user?: { name: string | null } }>;
  createdBy?: { email: string };
  updatedAt?: string;
  createdAt?: string;
}

interface KanList {
  publicId: string;
  name: string;
  cards?: KanCard[];
}

interface KanBoard {
  publicId: string;
  name: string;
  lists?: KanList[];
}

interface KanWorkspaceMember {
  publicId: string;
  email: string;
  role: string;
  status: string;
  user: { name: string | null } | null;
}

type UserLinkMap = Map<
  string,
  { telegramUserId: number; telegramUsername: string | null }
>;

type WorkspaceLink = {
  telegramChatId: number;
  workspacePublicId: string;
  workspaceName: string;
  messageThreadId: number | null;
};

export function startTaskChecker(bot: Bot) {
  const cronExpression = `0 */${REMINDER_INTERVAL_HOURS} * * *`;

  console.log(
    `Starting task checker with schedule: ${cronExpression} (every ${REMINDER_INTERVAL_HOURS} hour(s))`
  );

  cron.schedule(cronExpression, async () => {
    console.log("Running task check...");
    await checkAllTaskIssues(bot);
  });

  // Clean old reminders daily at 3am
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

/** Call an MCP tool and parse the JSON response. */
async function callKanTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await mcpManager.callTool(toolName, args);
  return JSON.parse(result);
}

/** Fetch workspace details including members. */
async function fetchWorkspace(workspacePublicId: string): Promise<{ slug: string; members: KanWorkspaceMember[] }> {
  const data = await callKanTool("kan_get_workspace", { workspace_id: workspacePublicId }) as Record<string, unknown>;
  return {
    slug: (data as { slug?: string }).slug || "",
    members: ((data as { members?: KanWorkspaceMember[] }).members || []),
  };
}

/** Fetch all boards with lists and cards for a workspace. */
async function fetchFullBoards(workspacePublicId: string): Promise<KanBoard[]> {
  const boards = await callKanTool("kan_list_boards", { workspace_id: workspacePublicId }) as KanBoard[];
  const fullBoards: KanBoard[] = [];

  for (const board of boards) {
    const fullBoard = await callKanTool("kan_get_board", { board_id: board.publicId }) as KanBoard;
    fullBoards.push(fullBoard);
  }

  return fullBoards;
}

async function checkAllTaskIssues(bot: Bot) {
  try {
    const workspaceLinks = await getAllWorkspaceLinks();
    const userLinks = await getAllUserLinks();

    if (workspaceLinks.length === 0) {
      console.log("No workspace links configured, skipping check.");
      return;
    }

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
  let workspaceSlug = "";
  let workspaceMembers: KanWorkspaceMember[] = [];
  let fullBoards: KanBoard[] = [];

  try {
    const workspace = await fetchWorkspace(workspaceLink.workspacePublicId);
    workspaceSlug = workspace.slug;
    workspaceMembers = workspace.members;
    fullBoards = await fetchFullBoards(workspaceLink.workspacePublicId);
  } catch (error) {
    console.log(
      `Cannot access workspace ${workspaceLink.workspaceName}: ${error}`
    );
    return;
  }

  const inPlanningWindow = isSprintPlanningWindow();
  const sprintInfo = getSprintInfo();
  console.log(`Sprint day ${sprintInfo.day}, planning window: ${inPlanningWindow}`);

  const checks: Promise<void>[] = [
    checkOverdueTasks(bot, fullBoards, workspaceLink, userLinksByEmail),
    checkStaleTasks(bot, fullBoards, workspaceLink, userLinksByEmail),
    checkUnassignedTasks(bot, fullBoards, workspaceLink),
  ];

  if (inPlanningWindow) {
    checks.push(
      checkNoDueDates(bot, fullBoards, workspaceLink, userLinksByEmail),
      checkVagueTasks(bot, fullBoards, workspaceLink, userLinksByEmail),
      checkNoTasks(bot, fullBoards, workspaceMembers, workspaceLink, workspaceSlug, userLinksByEmail)
    );
  }

  await Promise.all(checks);
}

function getAssigneeUsernames(card: KanCard, userLinksByEmail: UserLinkMap): string[] {
  const usernames: string[] = [];
  if (card.members) {
    for (const member of card.members) {
      const userLink = userLinksByEmail.get(member.email.toLowerCase());
      if (userLink?.telegramUsername) {
        usernames.push(userLink.telegramUsername);
      }
    }
  }
  return usernames;
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

function isSkipList(listName: string, ...keywords: string[]): boolean {
  const lower = listName.toLowerCase();
  return keywords.some((k) => lower.includes(k));
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
    console.log(`Sent ${reminderType} reminder for "${cardTitle}" to chat ${chatId}`);
  } catch (error) {
    if (await handleUnreachableChat(error, chatId)) return;
    console.error(`Failed to send ${reminderType} reminder to chat ${chatId}:`, error);
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*\[\]()~`>#+=|{}.!-]/g, "\\$&");
}

function formatDueDate(dueDate: string | null): string {
  if (!dueDate) return "No due date";
  const date = new Date(dueDate);
  const now = new Date();
  const diffDays = Math.floor((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  const dateStr = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
  if (diffDays < 0) {
    const overdueDays = Math.abs(diffDays);
    return `${dateStr} (${overdueDays} day${overdueDays === 1 ? "" : "s"} overdue)`;
  }
  if (diffDays === 0) return `${dateStr} (today)`;
  if (diffDays === 1) return `${dateStr} (tomorrow)`;
  if (diffDays <= 7) return `${dateStr} (in ${diffDays} days)`;
  return dateStr;
}

/**
 * Compose a reminder message via the agent loop so it lands in conversation history.
 * Uses userId: 0 as a system sentinel and disables tools for fast single-round execution.
 */
async function composeViaAgent(
  bot: Bot,
  chatId: number,
  prompt: string,
  messageThreadId?: number | null,
): Promise<string> {
  return await runAgentLoop(bot.api, {
    text: prompt,
    chatId,
    userId: 0,
    isAdmin: true,
    isSystemInitiated: true,
    ...(messageThreadId ? { messageThreadId } : {}),
  });
}

/**
 * Send an agent-composed message to Telegram with Markdown, falling back to plain text.
 */
async function sendAgentMessage(
  bot: Bot,
  chatId: number,
  message: string,
  messageThreadId?: number | null,
): Promise<void> {
  const opts = {
    link_preview_options: { is_disabled: true } as const,
    ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
  };
  try {
    await bot.api.sendMessage(chatId, message, { parse_mode: "Markdown", ...opts });
  } catch (err: unknown) {
    const isParseError = err instanceof Error && err.message.includes("can't parse entities");
    if (isParseError) {
      console.warn("Markdown parse failed for agent reminder, falling back to plain text");
      await bot.api.sendMessage(chatId, message, opts);
    } else {
      throw err;
    }
  }
}

// --- Overdue ---

async function checkOverdueTasks(
  bot: Bot,
  boards: KanBoard[],
  workspaceLink: WorkspaceLink,
  userLinksByEmail: UserLinkMap
) {
  try {
    for (const board of boards) {
      for (const list of board.lists || []) {
        if (isSkipList(list.name, "done", "complete", "archive", "backlog")) continue;

        for (const card of list.cards || []) {
          if (!card.dueDate || new Date(card.dueDate) >= new Date()) continue;
          if (!(await shouldSendReminder(card.publicId, workspaceLink.telegramChatId, "overdue"))) continue;

          const assigneeUsernames = getAssigneeUsernames(card, userLinksByEmail);
          const mentions = assigneeUsernames.map((u) => `@${u}`).join(" ");
          const daysOverdue = Math.floor((Date.now() - new Date(card.dueDate).getTime()) / (1000 * 60 * 60 * 24));

          const cardUrl = `${KAN_BASE_URL}/cards/${card.publicId}`;
          const boardUrl = `${KAN_BASE_URL}/boards/${board.publicId}`;

          const prompt = [
            `[SCHEDULED REMINDER — overdue task]`,
            ``,
            `Task overdue by ${daysOverdue} day${daysOverdue === 1 ? "" : "s"}:`,
            `- "${card.title}" — ${cardUrl}`,
            `  Board: ${board.name} (${boardUrl}) > ${list.name}`,
            `  Due: ${formatDueDate(card.dueDate)}`,
            mentions ? `  Assigned to: ${mentions}` : `  No assignee`,
            ``,
            `Notify the chat about this overdue task.`,
          ].join("\n");

          try {
            const agentMessage = await composeViaAgent(bot, workspaceLink.telegramChatId, prompt, workspaceLink.messageThreadId);
            await sendAgentMessage(bot, workspaceLink.telegramChatId, agentMessage, workspaceLink.messageThreadId);
            await upsertReminder(card.publicId, workspaceLink.telegramChatId, "overdue");
            console.log(`Sent overdue reminder for "${card.title}" to chat ${workspaceLink.telegramChatId}`);
          } catch (error) {
            console.warn(`Agent composition failed for overdue reminder, falling back to direct send:`, error);
            let message = `Task overdue by ${daysOverdue} day${daysOverdue === 1 ? "" : "s"}\\!\n\n`;
            message += `[${escapeMarkdown(card.title)}](${cardUrl})\n`;
            message += `[${escapeMarkdown(board.name)}](${boardUrl}) › ${escapeMarkdown(list.name)}\n`;
            message += `Due: ${escapeMarkdown(formatDueDate(card.dueDate))}\n\n`;
            if (mentions) message += `${mentions} `;
            await sendReminderMessage(bot, workspaceLink.telegramChatId, card.publicId, "overdue", message, card.title, workspaceLink.messageThreadId);
          }
        }
      }
    }
  } catch (error) {
    console.error(`Error checking overdue tasks for workspace ${workspaceLink.workspaceName}:`, error);
  }
}

// --- No Due Dates ---

async function checkNoDueDates(
  bot: Bot,
  boards: KanBoard[],
  workspaceLink: WorkspaceLink,
  userLinksByEmail: UserLinkMap
) {
  try {
    const tasksToRemind: Array<{ card: KanCard; board: KanBoard; list: KanList; assigneeUsernames: string[] }> = [];

    for (const board of boards) {
      for (const list of board.lists || []) {
        if (isSkipList(list.name, "done", "complete", "archive", "backlog")) continue;

        for (const card of list.cards || []) {
          if (card.dueDate) continue;
          if (!(await shouldSendReminder(card.publicId, workspaceLink.telegramChatId, "no_due_date"))) continue;
          tasksToRemind.push({ card, board, list, assigneeUsernames: getAssigneeUsernames(card, userLinksByEmail) });
        }
      }
    }

    if (tasksToRemind.length === 0) return;

    const promptLines = [
      `[SCHEDULED REMINDER — tasks without due dates]`,
      ``,
      `The following ${tasksToRemind.length} task${tasksToRemind.length === 1 ? " has" : "s have"} no due date:`,
      ``,
    ];
    for (const [i, item] of tasksToRemind.entries()) {
      const cardUrl = `${KAN_BASE_URL}/cards/${item.card.publicId}`;
      const boardUrl = `${KAN_BASE_URL}/boards/${item.board.publicId}`;
      const mentions = item.assigneeUsernames.map((u) => `@${u}`).join(" ");
      promptLines.push(`${i + 1}. "${item.card.title}" — ${cardUrl}`);
      promptLines.push(`   Board: ${item.board.name} (${boardUrl}) > ${item.list.name}`);
      if (mentions) promptLines.push(`   Assigned to: ${mentions}`);
    }
    promptLines.push(``, `Notify the chat about these tasks needing due dates.`);

    try {
      const agentMessage = await composeViaAgent(bot, workspaceLink.telegramChatId, promptLines.join("\n"), workspaceLink.messageThreadId);
      await sendAgentMessage(bot, workspaceLink.telegramChatId, agentMessage, workspaceLink.messageThreadId);
      for (const { card } of tasksToRemind) {
        await upsertReminder(card.publicId, workspaceLink.telegramChatId, "no_due_date");
      }
      console.log(`Sent no-due-date reminder for ${tasksToRemind.length} task(s) to chat ${workspaceLink.telegramChatId}`);
    } catch (agentError) {
      console.warn(`Agent composition failed for no-due-date reminder, falling back to direct send:`, agentError);
      let message = `📅 ${tasksToRemind.length} task${tasksToRemind.length === 1 ? " needs" : "s need"} a due date\n\n`;
      message += tasksToRemind.map((item, i) => {
        const cardUrl = `${KAN_BASE_URL}/cards/${item.card.publicId}`;
        const boardUrl = `${KAN_BASE_URL}/boards/${item.board.publicId}`;
        const mentions = item.assigneeUsernames.map((u) => `@${u}`).join(" ");
        let line = `${i + 1}\\. [${escapeMarkdown(item.card.title)}](${cardUrl})\n   [${escapeMarkdown(item.board.name)}](${boardUrl}) › ${escapeMarkdown(item.list.name)}`;
        if (mentions) line += `\n   ${mentions}`;
        return line;
      }).join("\n\n");

      try {
        await bot.api.sendMessage(workspaceLink.telegramChatId, message, {
          parse_mode: "MarkdownV2",
          link_preview_options: { is_disabled: true },
          ...(workspaceLink.messageThreadId ? { message_thread_id: workspaceLink.messageThreadId } : {}),
        });
        for (const { card } of tasksToRemind) {
          await upsertReminder(card.publicId, workspaceLink.telegramChatId, "no_due_date");
        }
      } catch (error) {
        if (await handleUnreachableChat(error, workspaceLink.telegramChatId)) return;
        console.error(`Failed to send no-due-date reminder to chat ${workspaceLink.telegramChatId}:`, error);
      }
    }
  } catch (error) {
    console.error(`Error checking no-due-date tasks for workspace ${workspaceLink.workspaceName}:`, error);
  }
}

// --- Vague Tasks ---

async function checkVagueTasks(
  bot: Bot,
  boards: KanBoard[],
  workspaceLink: WorkspaceLink,
  userLinksByEmail: UserLinkMap
) {
  try {
    const tasksToRemind: Array<{ card: KanCard; board: KanBoard; list: KanList; assigneeUsernames: string[]; reason?: string | null }> = [];

    for (const board of boards) {
      for (const list of board.lists || []) {
        if (isSkipList(list.name, "done", "complete", "archive")) continue;

        for (const card of list.cards || []) {
          const descLength = card.description?.trim().length || 0;
          if (descLength >= 100) continue;
          if (!(await shouldSendReminder(card.publicId, workspaceLink.telegramChatId, "vague"))) continue;

          const evaluation = await evaluateTaskVagueness({
            title: card.title,
            description: card.description,
            listName: list.name,
          });
          if (!evaluation.isVague) continue;

          tasksToRemind.push({
            card, board, list,
            assigneeUsernames: getAssigneeUsernames(card, userLinksByEmail),
            reason: evaluation.reason,
          });
        }
      }
    }

    if (tasksToRemind.length === 0) return;

    const promptLines = [
      `[SCHEDULED REMINDER — tasks needing more detail]`,
      ``,
      `The following ${tasksToRemind.length} task${tasksToRemind.length === 1 ? " is" : "s are"} too vague:`,
      ``,
    ];
    for (const [i, item] of tasksToRemind.entries()) {
      const cardUrl = `${KAN_BASE_URL}/cards/${item.card.publicId}`;
      const boardUrl = `${KAN_BASE_URL}/boards/${item.board.publicId}`;
      const mentions = item.assigneeUsernames.map((u) => `@${u}`).join(" ");
      promptLines.push(`${i + 1}. "${item.card.title}" — ${cardUrl}`);
      promptLines.push(`   Board: ${item.board.name} (${boardUrl}) > ${item.list.name}`);
      if (item.reason) promptLines.push(`   Issue: ${item.reason}`);
      if (mentions) promptLines.push(`   Assigned to: ${mentions}`);
    }
    promptLines.push(``, `Notify the chat that these tasks need better descriptions or acceptance criteria.`);

    try {
      const agentMessage = await composeViaAgent(bot, workspaceLink.telegramChatId, promptLines.join("\n"), workspaceLink.messageThreadId);
      await sendAgentMessage(bot, workspaceLink.telegramChatId, agentMessage, workspaceLink.messageThreadId);
      for (const { card } of tasksToRemind) {
        await upsertReminder(card.publicId, workspaceLink.telegramChatId, "vague");
      }
      console.log(`Sent vague task reminder for ${tasksToRemind.length} task(s) to chat ${workspaceLink.telegramChatId}`);
    } catch (agentError) {
      console.warn(`Agent composition failed for vague task reminder, falling back to direct send:`, agentError);
      let message = `📝 ${tasksToRemind.length} task${tasksToRemind.length === 1 ? " needs" : "s need"} more detail\n\n`;
      message += tasksToRemind.map((item, i) => {
        const cardUrl = `${KAN_BASE_URL}/cards/${item.card.publicId}`;
        const boardUrl = `${KAN_BASE_URL}/boards/${item.board.publicId}`;
        const mentions = item.assigneeUsernames.map((u) => `@${u}`).join(" ");
        let line = `${i + 1}\\. [${escapeMarkdown(item.card.title)}](${cardUrl})\n   [${escapeMarkdown(item.board.name)}](${boardUrl}) › ${escapeMarkdown(item.list.name)}`;
        if (item.reason) line += `\n   _${escapeMarkdown(item.reason)}_`;
        if (mentions) line += `\n   ${mentions}`;
        return line;
      }).join("\n\n");

      try {
        await bot.api.sendMessage(workspaceLink.telegramChatId, message, {
          parse_mode: "MarkdownV2",
          link_preview_options: { is_disabled: true },
          ...(workspaceLink.messageThreadId ? { message_thread_id: workspaceLink.messageThreadId } : {}),
        });
        for (const { card } of tasksToRemind) {
          await upsertReminder(card.publicId, workspaceLink.telegramChatId, "vague");
        }
      } catch (error) {
        if (await handleUnreachableChat(error, workspaceLink.telegramChatId)) return;
        console.error(`Failed to send vague task reminder to chat ${workspaceLink.telegramChatId}:`, error);
      }
    }
  } catch (error) {
    console.error(`Error checking vague tasks for workspace ${workspaceLink.workspaceName}:`, error);
  }
}

// --- Stale Tasks ---

async function checkStaleTasks(
  bot: Bot,
  boards: KanBoard[],
  workspaceLink: WorkspaceLink,
  userLinksByEmail: UserLinkMap
) {
  const staleDays = 14;
  const staleThreshold = Date.now() - staleDays * 24 * 60 * 60 * 1000;

  try {
    for (const board of boards) {
      for (const list of board.lists || []) {
        const lower = list.name.toLowerCase();
        if (!lower.includes("progress") && !lower.includes("doing") && !lower.includes("working") && !lower.includes("review")) continue;

        for (const card of list.cards || []) {
          const lastActivity = card.updatedAt || card.createdAt;
          if (!lastActivity) continue;

          const lastActivityDate = new Date(lastActivity).getTime();
          if (lastActivityDate >= staleThreshold) continue;

          const daysStale = Math.floor((Date.now() - lastActivityDate) / (1000 * 60 * 60 * 24));
          if (!(await shouldSendReminder(card.publicId, workspaceLink.telegramChatId, "stale"))) continue;

          const assigneeUsernames = getAssigneeUsernames(card, userLinksByEmail);
          const mentions = assigneeUsernames.map((u) => `@${u}`).join(" ");

          const cardUrl = `${KAN_BASE_URL}/cards/${card.publicId}`;
          const boardUrl = `${KAN_BASE_URL}/boards/${board.publicId}`;

          const prompt = [
            `[SCHEDULED REMINDER — stale task]`,
            ``,
            `This task has been in progress for ${daysStale} day${daysStale === 1 ? "" : "s"} without updates:`,
            `- "${card.title}" — ${cardUrl}`,
            `  Board: ${board.name} (${boardUrl}) > ${list.name}`,
            mentions ? `  Assigned to: ${mentions}` : `  No assignee`,
            ``,
            `Nudge the chat about this potentially stuck task. Ask if they need help unblocking it.`,
          ].join("\n");

          try {
            const agentMessage = await composeViaAgent(bot, workspaceLink.telegramChatId, prompt, workspaceLink.messageThreadId);
            await sendAgentMessage(bot, workspaceLink.telegramChatId, agentMessage, workspaceLink.messageThreadId);
            await upsertReminder(card.publicId, workspaceLink.telegramChatId, "stale");
            console.log(`Sent stale reminder for "${card.title}" to chat ${workspaceLink.telegramChatId}`);
          } catch (error) {
            console.warn(`Agent composition failed for stale reminder, falling back to direct send:`, error);
            let message = `⏰ Task stuck in progress\n\n`;
            message += `[${escapeMarkdown(card.title)}](${cardUrl})\n`;
            message += `[${escapeMarkdown(board.name)}](${boardUrl}) › ${escapeMarkdown(list.name)}\n`;
            message += `In progress for ${daysStale} day${daysStale === 1 ? "" : "s"}\n\n`;
            message += mentions ? `${mentions}, need help unblocking this\\?\n\n` : `This task may be blocked\\.\n\n`;
            await sendReminderMessage(bot, workspaceLink.telegramChatId, card.publicId, "stale", message, card.title, workspaceLink.messageThreadId);
          }
        }
      }
    }
  } catch (error) {
    console.error(`Error checking stale tasks for workspace ${workspaceLink.workspaceName}:`, error);
  }
}

// --- Unassigned Tasks ---

async function checkUnassignedTasks(
  bot: Bot,
  boards: KanBoard[],
  workspaceLink: WorkspaceLink,
) {
  try {
    const tasksToRemind: Array<{ card: KanCard; board: KanBoard; list: KanList }> = [];

    for (const board of boards) {
      for (const list of board.lists || []) {
        if (isSkipList(list.name, "done", "complete", "archive", "backlog")) continue;

        for (const card of list.cards || []) {
          if (card.members && card.members.length > 0) continue;
          if (!(await shouldSendReminder(card.publicId, workspaceLink.telegramChatId, "unassigned"))) continue;
          tasksToRemind.push({ card, board, list });
        }
      }
    }

    if (tasksToRemind.length === 0) return;

    const promptLines = [
      `[SCHEDULED REMINDER — unassigned tasks]`,
      ``,
      `The following ${tasksToRemind.length} task${tasksToRemind.length === 1 ? " has" : "s have"} no assignee:`,
      ``,
    ];
    for (const [i, item] of tasksToRemind.entries()) {
      const cardUrl = `${KAN_BASE_URL}/cards/${item.card.publicId}`;
      const boardUrl = `${KAN_BASE_URL}/boards/${item.board.publicId}`;
      promptLines.push(`${i + 1}. "${item.card.title}" — ${cardUrl}`);
      promptLines.push(`   Board: ${item.board.name} (${boardUrl}) > ${item.list.name}`);
    }
    promptLines.push(``, `Notify the chat about these unassigned tasks.`);

    try {
      const agentMessage = await composeViaAgent(bot, workspaceLink.telegramChatId, promptLines.join("\n"), workspaceLink.messageThreadId);
      await sendAgentMessage(bot, workspaceLink.telegramChatId, agentMessage, workspaceLink.messageThreadId);
      for (const { card } of tasksToRemind) {
        await upsertReminder(card.publicId, workspaceLink.telegramChatId, "unassigned");
      }
      console.log(`Sent unassigned reminder for ${tasksToRemind.length} task(s) to chat ${workspaceLink.telegramChatId}`);
    } catch (agentError) {
      console.warn(`Agent composition failed for unassigned reminder, falling back to direct send:`, agentError);
      let message = `👤 ${tasksToRemind.length} task${tasksToRemind.length === 1 ? " needs" : "s need"} an owner\n\n`;
      message += tasksToRemind.map((item, i) => {
        const cardUrl = `${KAN_BASE_URL}/cards/${item.card.publicId}`;
        const boardUrl = `${KAN_BASE_URL}/boards/${item.board.publicId}`;
        return `${i + 1}\\. [${escapeMarkdown(item.card.title)}](${cardUrl})\n   [${escapeMarkdown(item.board.name)}](${boardUrl}) › ${escapeMarkdown(item.list.name)}`;
      }).join("\n\n");

      try {
        await bot.api.sendMessage(workspaceLink.telegramChatId, message, {
          parse_mode: "MarkdownV2",
          link_preview_options: { is_disabled: true },
          ...(workspaceLink.messageThreadId ? { message_thread_id: workspaceLink.messageThreadId } : {}),
        });
        for (const { card } of tasksToRemind) {
          await upsertReminder(card.publicId, workspaceLink.telegramChatId, "unassigned");
        }
      } catch (error) {
        if (await handleUnreachableChat(error, workspaceLink.telegramChatId)) return;
        console.error(`Failed to send unassigned reminder to chat ${workspaceLink.telegramChatId}:`, error);
      }
    }
  } catch (error) {
    console.error(`Error checking unassigned tasks for workspace ${workspaceLink.workspaceName}:`, error);
  }
}

// --- No Tasks ---

async function checkNoTasks(
  bot: Bot,
  boards: KanBoard[],
  members: KanWorkspaceMember[],
  workspaceLink: WorkspaceLink,
  workspaceSlug: string,
  userLinksByEmail: UserLinkMap
) {
  try {
    const membersWithTasks = new Set<string>();

    for (const board of boards) {
      for (const list of board.lists || []) {
        if (isSkipList(list.name, "done", "complete", "archive")) continue;

        for (const card of list.cards || []) {
          if (card.members) {
            for (const member of card.members) {
              membersWithTasks.add(member.publicId);
            }
          }
        }
      }
    }

    const membersWithNoTasks = members.filter(
      (m) => m.status === "active" && !membersWithTasks.has(m.publicId)
    );

    for (const member of membersWithNoTasks) {
      const syntheticId = `no_tasks:${member.publicId}`;
      if (!(await shouldSendReminder(syntheticId, workspaceLink.telegramChatId, "no_tasks"))) continue;

      const userLink = userLinksByEmail.get(member.email.toLowerCase());
      if (!userLink?.telegramUsername) continue;

      const mention = `@${userLink.telegramUsername}`;
      const url = `${KAN_BASE_URL}/${workspaceSlug}`;

      const prompt = [
        `[SCHEDULED REMINDER — team member with no tasks]`,
        ``,
        `${mention} has no tasks assigned for the current sprint.`,
        `Workspace: ${url}`,
        ``,
        `Nudge them to add their work to the board.`,
      ].join("\n");

      try {
        const agentMessage = await composeViaAgent(bot, workspaceLink.telegramChatId, prompt, workspaceLink.messageThreadId);
        await sendAgentMessage(bot, workspaceLink.telegramChatId, agentMessage, workspaceLink.messageThreadId);
        await upsertReminder(syntheticId, workspaceLink.telegramChatId, "no_tasks");
        console.log(`Sent no-tasks reminder for ${member.email} to chat ${workspaceLink.telegramChatId}`);
      } catch (error) {
        console.warn(`Agent composition failed for no-tasks reminder, falling back to direct send:`, error);
        let message = `📋 No tasks for the sprint\\?\n\n`;
        message += `${mention}, you don't have any tasks assigned\\.\n`;
        message += `Add your work to the board so we can track it\\!\n\n`;
        message += `[Open workspace](${url})`;
        await sendReminderMessage(bot, workspaceLink.telegramChatId, syntheticId, "no_tasks", message, `no tasks for ${member.email}`, workspaceLink.messageThreadId);
      }
    }
  } catch (error) {
    console.error(`Error checking members with no tasks for workspace ${workspaceLink.workspaceName}:`, error);
  }
}
