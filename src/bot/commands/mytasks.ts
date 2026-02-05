import type { AuthContext } from "../middleware/auth.js";
import { getUserLink, getWorkspaceLink } from "../../db/queries.js";
import { getServiceClient } from "../../api/kan-client.js";
import { formatCardList } from "../../utils/format.js";

export async function myTasksCommand(ctx: AuthContext) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!userId || !chatId) {
    await ctx.reply("Could not identify user or chat.");
    return;
  }

  // Get user link to find their email
  const userLink = await getUserLink(userId);
  if (!userLink) {
    await ctx.reply(
      "Your account hasn't been mapped yet.\n\n" +
        "Ask an admin to run: `/map @yourusername your@email.com`",
      { parse_mode: "Markdown" }
    );
    return;
  }

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
    // Get workspace members to find this user's member ID
    const workspace = await client.getWorkspace(workspaceLink.workspacePublicId);
    const member = workspace.members.find(
      (m) => m.email.toLowerCase() === userLink.kanUserEmail.toLowerCase()
    );

    if (!member) {
      await ctx.reply(
        `You don't appear to be a member of workspace "${workspaceLink.workspaceName}".\n\n` +
          "Make sure your Kan account email matches your workspace membership."
      );
      return;
    }

    // Get cards assigned to this member
    const tasks = await client.getCardsForMember(
      workspaceLink.workspacePublicId,
      member.publicId
    );

    if (tasks.length === 0) {
      await ctx.reply(
        `You have no active tasks assigned in *${workspaceLink.workspaceName}*`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Sort by due date (overdue first, then by date)
    tasks.sort((a, b) => {
      if (!a.card.dueDate && !b.card.dueDate) return 0;
      if (!a.card.dueDate) return 1;
      if (!b.card.dueDate) return -1;
      return new Date(a.card.dueDate).getTime() - new Date(b.card.dueDate).getTime();
    });

    const formattedList = formatCardList(tasks, {
      workspaceSlug: workspace.slug,
    });

    await ctx.reply(
      `Your tasks in *${workspaceLink.workspaceName}* (${tasks.length}):\n\n${formattedList}`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    console.error("Error fetching tasks:", error);
    await ctx.reply("Error fetching your tasks. Please try again.");
  }
}
