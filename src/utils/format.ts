import type { KanCard, KanBoard, KanList } from "../api/kan-client.js";

const KAN_BASE_URL = process.env.KAN_BASE_URL || "https://tasks.xdeca.com";

export function formatDueDate(dueDate: string | null): string {
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
  } else if (diffDays === 0) {
    return `${dateStr} (today)`;
  } else if (diffDays === 1) {
    return `${dateStr} (tomorrow)`;
  } else if (diffDays <= 7) {
    return `${dateStr} (in ${diffDays} days)`;
  }

  return dateStr;
}

export function formatCard(
  card: KanCard,
  board: KanBoard,
  list: KanList,
  options: { includeLink?: boolean; workspaceSlug?: string } = {}
): string {
  let text = `*${escapeMarkdown(card.title)}*\n`;
  text += `List: ${escapeMarkdown(list.name)} in ${escapeMarkdown(board.name)}\n`;

  if (card.dueDate) {
    text += `Due: ${formatDueDate(card.dueDate)}\n`;
  }

  if (card.members && card.members.length > 0) {
    const memberNames = card.members
      .map((m) => m.user?.name || m.email)
      .join(", ");
    text += `Assigned: ${escapeMarkdown(memberNames)}\n`;
  }

  if (options.includeLink && options.workspaceSlug) {
    const url = `${KAN_BASE_URL}/cards/${card.publicId}`;
    text += `[View in Kan](${url})\n`;
  }

  text += `ID: \`${card.publicId}\``;

  return text;
}

export function formatCardList(
  cards: Array<{ card: KanCard; board: KanBoard; list: KanList }>,
  options: { workspaceSlug?: string } = {}
): string {
  if (cards.length === 0) {
    return "No tasks found.";
  }

  return cards
    .map((item, index) => {
      const dueInfo = item.card.dueDate
        ? ` - ${formatDueDate(item.card.dueDate)}`
        : "";
      const title = `[${escapeMarkdown(item.card.title)}](${KAN_BASE_URL}/cards/${item.card.publicId})`;
      const boardLink = `[${escapeMarkdown(item.board.name)}](${KAN_BASE_URL}/boards/${item.board.publicId})`;
      return `${index + 1}. ${title}${dueInfo}\n   ${boardLink} › ${escapeMarkdown(item.list.name)}`;
    })
    .join("\n\n");
}

export function escapeMarkdown(text: string): string {
  // Escape MarkdownV2 special characters
  return text.replace(/[_*\[\]()~`>#+=|{}.!-]/g, "\\$&");
}

export function formatOverdueReminder(
  card: KanCard,
  board: KanBoard,
  list: KanList,
  assigneeUsernames: string[],
  workspaceSlug: string
): string {
  const mentions = assigneeUsernames.map((u) => `@${u}`).join(" ");
  const daysOverdue = Math.floor(
    (Date.now() - new Date(card.dueDate!).getTime()) / (1000 * 60 * 60 * 24)
  );

  let text = `Task overdue by ${daysOverdue} day${daysOverdue === 1 ? "" : "s"}\\!\n\n`;
  text += `*${escapeMarkdown(card.title)}*\n`;
  text += `List: ${escapeMarkdown(list.name)} in ${escapeMarkdown(board.name)}\n`;
  text += `Due: ${formatDueDate(card.dueDate)}\n\n`;

  if (mentions) {
    text += `${mentions} `;
  }

  const url = `${KAN_BASE_URL}/cards/${card.publicId}`;
  text += `[View task](${url})`;

  return text;
}

export function formatNoDueDateReminder(
  card: KanCard,
  board: KanBoard,
  list: KanList,
  assigneeUsernames: string[],
  workspaceSlug: string
): string {
  const mentions = assigneeUsernames.map((u) => `@${u}`).join(" ");

  let text = `📅 Task needs a due date\n\n`;
  text += `*${escapeMarkdown(card.title)}*\n`;
  text += `List: ${escapeMarkdown(list.name)} in ${escapeMarkdown(board.name)}\n\n`;

  if (mentions) {
    text += `${mentions}, when do you expect to finish this\\?\n\n`;
  } else {
    text += `When should this be done\\?\n\n`;
  }

  const url = `${KAN_BASE_URL}/cards/${card.publicId}`;
  text += `[View task](${url})`;

  return text;
}

export function formatVagueTaskReminder(
  card: KanCard,
  board: KanBoard,
  list: KanList,
  assigneeUsernames: string[],
  workspaceSlug: string,
  reason?: string | null
): string {
  const mentions = assigneeUsernames.map((u) => `@${u}`).join(" ");

  let text = `📝 Task needs more detail\n\n`;
  text += `*${escapeMarkdown(card.title)}*\n`;
  text += `List: ${escapeMarkdown(list.name)} in ${escapeMarkdown(board.name)}\n`;

  if (reason) {
    text += `_${escapeMarkdown(reason)}_\n`;
  }

  text += `\n`;

  if (mentions) {
    text += `${mentions}, can you add more detail\\?\n\n`;
  } else {
    text += `This task needs more detail\\.\n\n`;
  }

  const url = `${KAN_BASE_URL}/cards/${card.publicId}`;
  text += `[View task](${url})`;

  return text;
}

export function formatStaleTaskReminder(
  card: KanCard,
  board: KanBoard,
  list: KanList,
  assigneeUsernames: string[],
  workspaceSlug: string,
  daysStale: number
): string {
  const mentions = assigneeUsernames.map((u) => `@${u}`).join(" ");

  let text = `⏰ Task stuck in progress\n\n`;
  text += `*${escapeMarkdown(card.title)}*\n`;
  text += `List: ${escapeMarkdown(list.name)} in ${escapeMarkdown(board.name)}\n`;
  text += `In progress for ${daysStale} day${daysStale === 1 ? "" : "s"}\n\n`;

  if (mentions) {
    text += `${mentions}, need help unblocking this\\?\n\n`;
  } else {
    text += `This task may be blocked\\.\n\n`;
  }

  const url = `${KAN_BASE_URL}/cards/${card.publicId}`;
  text += `[View task](${url})`;

  return text;
}

export function formatUnassignedReminder(
  card: KanCard,
  board: KanBoard,
  list: KanList,
  workspaceSlug: string,
  creatorUsername?: string | null
): string {
  let text = `👤 Task needs an owner\n\n`;
  text += `*${escapeMarkdown(card.title)}*\n`;
  text += `List: ${escapeMarkdown(list.name)} in ${escapeMarkdown(board.name)}\n\n`;

  if (creatorUsername) {
    text += `@${creatorUsername}, who's working on this\\?\n\n`;
  } else {
    text += `Who's working on this\\?\n\n`;
  }

  const url = `${KAN_BASE_URL}/cards/${card.publicId}`;
  text += `[View task](${url})`;

  return text;
}

export function formatNoTasksReminder(
  telegramUsername: string | null,
  memberName: string | null,
  workspaceSlug: string
): string {
  const mention = telegramUsername ? `@${telegramUsername}` : escapeMarkdown(memberName || "Someone");

  let text = `📋 No tasks for the sprint\\?\n\n`;
  text += `${mention}, you don't have any tasks assigned\\.\n`;
  text += `Add your work to the board so we can track it\\!\n\n`;

  const url = `${KAN_BASE_URL}/${workspaceSlug}`;
  text += `[Open workspace](${url})`;

  return text;
}
