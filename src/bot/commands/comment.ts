import type { AuthContext } from "../middleware/auth.js";
import { getWorkspaceLink } from "../../db/queries.js";
import { getServiceClient } from "../../api/kan-client.js";

export async function commentCommand(ctx: AuthContext) {
  const chatId = ctx.chat?.id;
  const args = ctx.message?.text?.split(" ").slice(1);

  if (!chatId) {
    await ctx.reply("Could not identify chat.");
    return;
  }

  if (!args || args.length < 2) {
    await ctx.reply(
      "Usage: `/comment <task-id> <your comment>`\n\n" +
        "Example: `/comment abc123 Working on this now`\n\n" +
        "Use `/mytasks` or `/overdue` to see task IDs.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const cardPublicId = args[0];
  const commentText = args.slice(1).join(" ");

  if (commentText.length > 5000) {
    await ctx.reply("Comment is too long. Maximum 5000 characters.");
    return;
  }

  // Get workspace link (for context)
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
    // First verify the card exists
    const card = await client.getCard(cardPublicId);

    // Add the comment
    await client.addComment(cardPublicId, commentText);

    await ctx.reply(
      `Comment added to task:\n\n` +
        `*${card.title}*\n\n` +
        `"${commentText.length > 100 ? commentText.substring(0, 100) + "..." : commentText}"`,
      { parse_mode: "Markdown" }
    );
  } catch (error: unknown) {
    console.error("Error adding comment:", error);

    if (error instanceof Error && error.message.includes("404")) {
      await ctx.reply(
        `Task with ID "${cardPublicId}" not found.\n\n` +
          "Use `/mytasks` or `/overdue` to see valid task IDs.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    await ctx.reply("Error adding comment. Please try again.");
  }
}
