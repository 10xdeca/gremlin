import type { AuthContext } from "../middleware/auth.js";
import { getWorkspaceLink } from "../../db/queries.js";
import { getServiceClient } from "../../api/kan-client.js";

export async function doneCommand(ctx: AuthContext) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const args = ctx.message?.text?.split(" ").slice(1);

  if (!userId || !chatId) {
    await ctx.reply("Could not identify user or chat.");
    return;
  }

  if (!args || args.length === 0) {
    await ctx.reply(
      "Usage: `/done <task-id>`\n\n" +
        "Example: `/done abc123def456`\n\n" +
        "Use `/mytasks` or `/overdue` to see task IDs.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const cardPublicId = args[0];

  // Get workspace link
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
    // Get the card first to find its board
    const card = await client.getCard(cardPublicId);

    // Get the board to find the "Done" list
    const boards = await client.getBoards(workspaceLink.workspacePublicId);

    // Find the board containing this card's list
    let targetBoard = null;
    let currentList = null;

    for (const board of boards) {
      const fullBoard = await client.getBoard(board.publicId);
      for (const list of fullBoard.lists || []) {
        if (list.id === card.listId) {
          targetBoard = fullBoard;
          currentList = list;
          break;
        }
      }
      if (targetBoard) break;
    }

    if (!targetBoard) {
      await ctx.reply("Could not find the board containing this task.");
      return;
    }

    // Find "Done" list
    const doneList = await client.findDoneList(targetBoard.publicId);

    if (!doneList) {
      await ctx.reply(
        `No "Done" or "Complete" list found in board "${targetBoard.name}".\n\n` +
          "Please create a list named 'Done' to use this feature.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Check if already in done list
    if (currentList && currentList.publicId === doneList.publicId) {
      await ctx.reply(`Task "${card.title}" is already in the Done list.`);
      return;
    }

    // Move the card to Done list
    await client.updateCard(cardPublicId, {
      listPublicId: doneList.publicId,
    });

    const fromListName = currentList?.name || "Unknown";
    await ctx.reply(
      `Task marked as done:\n\n` +
        `*${card.title}*\n` +
        `Moved from "${fromListName}" to "${doneList.name}"`,
      { parse_mode: "Markdown" }
    );
  } catch (error: unknown) {
    console.error("Error marking task as done:", error);

    if (error instanceof Error && error.message.includes("404")) {
      await ctx.reply(
        `Task with ID "${cardPublicId}" not found.\n\n` +
          "Use `/mytasks` or `/overdue` to see valid task IDs.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    await ctx.reply("Error marking task as done. Please try again.");
  }
}
