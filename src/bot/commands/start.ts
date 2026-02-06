import type { Context } from "grammy";
import { getServiceClient } from "../../api/kan-client.js";
import {
  createWorkspaceLink,
  deleteWorkspaceLink,
  getWorkspaceLink,
  updateWorkspaceLinkTopic,
} from "../../db/queries.js";
import { isAdmin, replyNotAdmin } from "../middleware/auth.js";

export async function startCommand(ctx: Context) {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  const args = ctx.message?.text?.split(" ").slice(1).join(" ");

  if (!chatId || !userId) {
    await ctx.reply("Could not identify chat or user.");
    return;
  }

  // Only allow linking in group chats
  if (args && ctx.chat?.type === "private") {
    await ctx.reply("Workspaces can only be linked in group chats, not DMs.");
    return;
  }

  // Admin check (only for linking, not for viewing status)
  if (args && !isAdmin(userId)) {
    await replyNotAdmin(ctx);
    return;
  }

  // Check if already linked
  const existingLink = await getWorkspaceLink(chatId);
  if (existingLink && !args) {
    await ctx.reply(
      `This chat is already linked to workspace: *${existingLink.workspaceName}*\n\n` +
        "To link to a different workspace, use:\n" +
        "`/start <workspace-slug-or-id>`\n\n" +
        "To unlink, use: `/unlink`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (!args) {
    await ctx.reply(
      "Welcome to the Kan Bot!\n\n" +
        "To get started, link this chat to a Kan workspace:\n" +
        "`/start <workspace-slug-or-id>`\n\n" +
        "Example: `/start my-team`\n\n" +
        "Then map team members with `/map` (DM me as admin).",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const client = getServiceClient();

  try {
    // Try to find the workspace
    const workspaces = await client.getWorkspaces();
    const workspace = workspaces.find(
      (w) =>
        w.publicId === args ||
        w.slug?.toLowerCase() === args.toLowerCase() ||
        w.name?.toLowerCase() === args.toLowerCase()
    );

    if (!workspace) {
      const workspaceList = workspaces
        .map((w) => `• ${w.name} (\`${w.slug}\`)`)
        .join("\n");

      await ctx.reply(
        `Workspace "${args}" not found.\n\n` +
          "Your available workspaces:\n" +
          workspaceList +
          "\n\nUse the slug or name to link.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Remove existing link if any
    if (existingLink) {
      await deleteWorkspaceLink(chatId);
    }

    // Capture forum topic thread ID if present
    const messageThreadId = ctx.message?.message_thread_id ?? null;

    // Create the link
    await createWorkspaceLink({
      telegramChatId: chatId,
      workspacePublicId: workspace.publicId,
      workspaceName: workspace.name,
      messageThreadId,
      createdByTelegramUserId: userId,
    });

    const topicNote = messageThreadId
      ? "\n_Reminders will be sent to this topic\\._\n"
      : "";

    await ctx.reply(
      `Chat linked to workspace: *${workspace.name}*\n${topicNote}\n` +
        "Available commands:\n" +
        "• `/mytasks` - View your assigned tasks\n" +
        "• `/overdue` - View all overdue tasks\n" +
        "• `/done <task-id>` - Mark a task as complete\n" +
        "• `/comment <task-id> <text>` - Add a comment\n" +
        "• `/help` - Show all commands",
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    console.error("Error in /start:", error);
    await ctx.reply(
      "Error connecting to Kan. Please check your API key is still valid."
    );
  }
}

export async function unlinkCommand(ctx: Context) {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;

  if (!chatId) {
    await ctx.reply("Could not identify chat.");
    return;
  }

  if (!isAdmin(userId)) {
    await replyNotAdmin(ctx);
    return;
  }

  const existingLink = await getWorkspaceLink(chatId);
  if (!existingLink) {
    await ctx.reply("This chat is not linked to any workspace.");
    return;
  }

  await deleteWorkspaceLink(chatId);
  await ctx.reply(
    `Unlinked from workspace: *${existingLink.workspaceName}*`,
    { parse_mode: "Markdown" }
  );
}

export async function setTopicCommand(ctx: Context) {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;

  if (!chatId) {
    await ctx.reply("Could not identify chat.");
    return;
  }

  if (!isAdmin(userId)) {
    await replyNotAdmin(ctx);
    return;
  }

  const existingLink = await getWorkspaceLink(chatId);
  if (!existingLink) {
    await ctx.reply("This chat is not linked to any workspace. Use `/start <workspace>` first.", {
      parse_mode: "Markdown",
    });
    return;
  }

  const messageThreadId = ctx.message?.message_thread_id ?? null;
  await updateWorkspaceLinkTopic(chatId, messageThreadId);

  if (messageThreadId) {
    await ctx.reply("Reminders will now be sent to this topic.");
  } else {
    await ctx.reply("Reminders will now be sent to the main chat (no topic).");
  }
}
