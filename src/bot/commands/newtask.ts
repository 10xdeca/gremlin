import type { Context } from "grammy";
import { getWorkspaceLink, getDefaultBoardConfig } from "../../db/queries.js";
import { getServiceClient } from "../../api/kan-client.js";
import { extractMentions, resolveMentionsToMembers } from "../../utils/mentions.js";

const KAN_BASE_URL = process.env.KAN_BASE_URL || "https://tasks.xdeca.com";

export async function newtaskCommand(ctx: Context) {
  const chatId = ctx.chat?.id;
  const args = ctx.message?.text?.split(" ").slice(1).join(" ")?.trim();

  if (!chatId) {
    await ctx.reply("Could not identify chat.");
    return;
  }

  if (!args) {
    await ctx.reply(
      "Usage: `/newtask <title> [@user ...]`\n\n" +
        "Examples:\n" +
        "• `/newtask Fix the login page`\n" +
        "• `/newtask Update CI pipeline @nick @alice`\n\n" +
        "Use `/setdefault` to configure which board/list new tasks go to.",
      { parse_mode: "Markdown" }
    );
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
    // Parse @mentions from the input
    const botUsername = ctx.me?.username;
    const { cleanText: title, usernames } = extractMentions(args, botUsername);

    if (!title) {
      await ctx.reply("Please provide a task title (not just @mentions).");
      return;
    }

    // Resolve target list
    const config = await getDefaultBoardConfig(chatId);
    let listPublicId: string;
    let listName: string;
    let boardName: string;

    if (config) {
      listPublicId = config.listPublicId;
      listName = config.listName;
      boardName = config.boardName;
    } else {
      // Auto-detect: first board, Backlog/To Do/first list
      const boards = await client.getBoards(workspaceLink.workspacePublicId);
      if (!boards.length) {
        await ctx.reply("No boards found in this workspace.");
        return;
      }
      const board = boards[0];
      const list = await client.findBacklogOrTodoList(board.publicId);
      if (!list) {
        await ctx.reply(`No lists found in board "${board.name}".`);
        return;
      }
      listPublicId = list.publicId;
      listName = list.name;
      boardName = board.name;
    }

    // Resolve @mentions to Kan member IDs
    const { resolved, unresolved } = await resolveMentionsToMembers(usernames);
    const memberPublicIds = resolved.map((r) => r.memberPublicId);

    // Create the card
    const card = await client.createCard(listPublicId, {
      title,
      memberPublicIds: memberPublicIds.length > 0 ? memberPublicIds : undefined,
    });

    // Build response
    const cardUrl = `${KAN_BASE_URL}/card/${card.publicId}`;
    let response = `Task created in *${boardName}* → ${listName}:\n\n` +
      `*${title}*\n` +
      `[Open in Kan](${cardUrl})`;

    if (resolved.length > 0) {
      const names = resolved.map((r) => `@${r.username}`).join(", ");
      response += `\n\nAssigned to: ${names}`;
    }

    if (unresolved.length > 0) {
      const names = unresolved.map((u) => `@${u}`).join(", ");
      response += `\n\n⚠️ Could not resolve: ${names} (use \`/map\` to link their accounts)`;
    }

    await ctx.reply(response, {
      parse_mode: "Markdown",
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    console.error("Error creating task:", error);
    await ctx.reply("Error creating task. Please try again.");
  }
}
