import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { nanoid } from "nanoid";
import { isAdmin, replyNotAdmin } from "../middleware/auth.js";
import { getWorkspaceLink, upsertDefaultBoardConfig, getDefaultBoardConfig } from "../../db/queries.js";
import { getServiceClient } from "../../api/kan-client.js";

/** Temporary store for board selection context to keep callback_data under Telegram's 64-byte limit */
interface PendingBoardSelection {
  boardPublicId: string;
  boardName: string;
  lists: Array<{ publicId: string; name: string }>;
  createdAt: number;
}

const pendingSelections = new Map<string, PendingBoardSelection>();
const SELECTION_TTL_MS = 10 * 60 * 1000; // 10 minutes

function storeBoardSelection(data: Omit<PendingBoardSelection, "createdAt">): string {
  const id = nanoid(10);
  pendingSelections.set(id, { ...data, createdAt: Date.now() });
  return id;
}

function getBoardSelection(id: string): PendingBoardSelection | undefined {
  const selection = pendingSelections.get(id);
  if (!selection) return undefined;
  if (Date.now() - selection.createdAt > SELECTION_TTL_MS) {
    pendingSelections.delete(id);
    return undefined;
  }
  return selection;
}

// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [id, selection] of pendingSelections.entries()) {
    if (now - selection.createdAt > SELECTION_TTL_MS) {
      pendingSelections.delete(id);
    }
  }
}, 5 * 60 * 1000);

export async function setdefaultCommand(ctx: Context) {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;

  if (!chatId || !userId) {
    await ctx.reply("Could not identify chat or user.");
    return;
  }

  if (!isAdmin(userId)) {
    await replyNotAdmin(ctx);
    return;
  }

  const workspaceLink = await getWorkspaceLink(chatId);
  if (!workspaceLink) {
    await ctx.reply(
      "This chat isn't linked to a Kan workspace yet.\n\n" +
        "Use `/start <workspace-slug>` to connect this chat.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const client = getServiceClient();

  try {
    const boards = await client.getBoards(workspaceLink.workspacePublicId);
    if (!boards.length) {
      await ctx.reply("No boards found in this workspace.");
      return;
    }

    // Show current config if any
    const current = await getDefaultBoardConfig(chatId);
    let statusText = "Select a board for new tasks:";
    if (current) {
      statusText = `Current default: *${current.boardName}* → ${current.listName}\n\nSelect a new board:`;
    }

    // Build inline keyboard with boards
    const keyboard = new InlineKeyboard();
    for (const board of boards) {
      keyboard.text(board.name, `sd:b:${board.publicId}`).row();
    }

    await ctx.reply(statusText, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  } catch (error) {
    console.error("Error in /setdefault:", error);
    await ctx.reply("Error fetching boards. Please try again.");
  }
}

/** Callback handler for board selection: shows lists within the chosen board */
export async function handleSetDefaultBoardCallback(ctx: Context) {
  const chatId = ctx.callbackQuery?.message?.chat.id;
  const data = ctx.callbackQuery?.data;

  if (!chatId || !data) {
    await ctx.answerCallbackQuery({ text: "Invalid selection." });
    return;
  }

  const boardPublicId = data.replace("sd:b:", "");
  const client = getServiceClient();

  try {
    const board = await client.getBoard(boardPublicId);
    const lists = board.lists || [];

    if (!lists.length) {
      await ctx.answerCallbackQuery({ text: "No lists found in this board." });
      return;
    }

    // Store board context and list options; use short IDs in callback data
    const selectionId = storeBoardSelection({
      boardPublicId,
      boardName: board.name,
      lists: lists.map((l) => ({ publicId: l.publicId, name: l.name })),
    });

    const keyboard = new InlineKeyboard();
    for (let i = 0; i < lists.length; i++) {
      // callback_data: "sd:l:<selectionId>:<index>" — well under 64 bytes
      keyboard.text(lists[i].name, `sd:l:${selectionId}:${i}`).row();
    }

    await ctx.editMessageText(`Board: *${board.name}*\n\nSelect a list for new tasks:`, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
    await ctx.answerCallbackQuery();
  } catch (error) {
    console.error("Error handling setdefault board callback:", error);
    await ctx.answerCallbackQuery({ text: "Error fetching lists." });
  }
}

/** Callback handler for list selection: saves the default config */
export async function handleSetDefaultListCallback(ctx: Context) {
  const chatId = ctx.callbackQuery?.message?.chat.id;
  const data = ctx.callbackQuery?.data;

  if (!chatId || !data) {
    await ctx.answerCallbackQuery({ text: "Invalid selection." });
    return;
  }

  // Format: sd:l:<selectionId>:<listIndex>
  const parts = data.replace("sd:l:", "").split(":");
  if (parts.length < 2) {
    await ctx.answerCallbackQuery({ text: "Invalid selection data." });
    return;
  }

  const [selectionId, listIndexStr] = parts;
  const selection = getBoardSelection(selectionId);

  if (!selection) {
    await ctx.answerCallbackQuery({ text: "Selection expired. Please run /setdefault again." });
    return;
  }

  const listIndex = parseInt(listIndexStr, 10);
  const list = selection.lists[listIndex];

  if (!list) {
    await ctx.answerCallbackQuery({ text: "Invalid list selection." });
    return;
  }

  try {
    await upsertDefaultBoardConfig({
      telegramChatId: chatId,
      boardPublicId: selection.boardPublicId,
      listPublicId: list.publicId,
      boardName: selection.boardName,
      listName: list.name,
    });

    await ctx.editMessageText(
      `Default set: *${selection.boardName}* → ${list.name}\n\n` +
        "New tasks from `/newtask` and auto-detection will be created here.",
      { parse_mode: "Markdown" }
    );
    await ctx.answerCallbackQuery({ text: "Default saved!" });
    pendingSelections.delete(selectionId);
  } catch (error) {
    console.error("Error saving default board config:", error);
    await ctx.answerCallbackQuery({ text: "Error saving default." });
  }
}
