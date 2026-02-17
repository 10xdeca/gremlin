import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { isAdmin, replyNotAdmin } from "../middleware/auth.js";
import { getWorkspaceLink, upsertDefaultBoardConfig, getDefaultBoardConfig } from "../../db/queries.js";
import { getServiceClient } from "../../api/kan-client.js";

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
      keyboard.text(board.name, `setdefault:board:${board.publicId}`).row();
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

  const boardPublicId = data.replace("setdefault:board:", "");
  const client = getServiceClient();

  try {
    const board = await client.getBoard(boardPublicId);
    const lists = board.lists || [];

    if (!lists.length) {
      await ctx.answerCallbackQuery({ text: "No lists found in this board." });
      return;
    }

    const keyboard = new InlineKeyboard();
    for (const list of lists) {
      keyboard.text(list.name, `setdefault:list:${boardPublicId}:${list.publicId}:${encodeURIComponent(board.name)}:${encodeURIComponent(list.name)}`).row();
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

  // Format: setdefault:list:<boardPublicId>:<listPublicId>:<boardName>:<listName>
  const parts = data.replace("setdefault:list:", "").split(":");
  if (parts.length < 4) {
    await ctx.answerCallbackQuery({ text: "Invalid selection data." });
    return;
  }

  const [boardPublicId, listPublicId, encodedBoardName, encodedListName] = parts;
  const boardName = decodeURIComponent(encodedBoardName);
  const listName = decodeURIComponent(encodedListName);

  try {
    await upsertDefaultBoardConfig({
      telegramChatId: chatId,
      boardPublicId,
      listPublicId,
      boardName,
      listName,
    });

    await ctx.editMessageText(
      `Default set: *${boardName}* → ${listName}\n\n` +
        "New tasks from `/newtask` and auto-detection will be created here.",
      { parse_mode: "Markdown" }
    );
    await ctx.answerCallbackQuery({ text: "Default saved!" });
  } catch (error) {
    console.error("Error saving default board config:", error);
    await ctx.answerCallbackQuery({ text: "Error saving default." });
  }
}
