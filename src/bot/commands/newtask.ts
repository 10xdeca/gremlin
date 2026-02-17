import type { Context } from "grammy";
import { getWorkspaceLink } from "../../db/queries.js";
import { extractMentions, resolveMentionsToMembers } from "../../utils/mentions.js";
import { startNewTaskFlow } from "../callbacks/newtask-flow.js";

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

  try {
    // Parse @mentions from the input
    const botUsername = ctx.me?.username;
    const { cleanText: title, usernames } = extractMentions(args, botUsername);

    if (!title) {
      await ctx.reply("Please provide a task title (not just @mentions).");
      return;
    }

    // Resolve @mentions to Kan member IDs
    const { resolved, unresolved } = await resolveMentionsToMembers(usernames);

    const result = await startNewTaskFlow({
      title,
      chatId,
      workspacePublicId: workspaceLink.workspacePublicId,
      mentionsProvided: usernames.length > 0,
      resolvedMembers: resolved.map((r) => ({ memberPublicId: r.memberPublicId, displayName: `@${r.username}` })),
      unresolvedMentions: unresolved,
    });

    if (result.type === "created") {
      await ctx.reply(result.text, {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true },
      });
    } else if (result.type === "picker") {
      await ctx.reply(result.text, {
        parse_mode: "Markdown",
        reply_markup: result.keyboard,
      });
    } else {
      await ctx.reply(result.text);
    }
  } catch (error) {
    console.error("Error creating task:", error);
    await ctx.reply("Error creating task. Please try again.");
  }
}
