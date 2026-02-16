import type { Context } from "grammy";
import { isAdmin, replyNotAdmin } from "../middleware/auth.js";
import { getWorkspaceLink, getActiveCeremony } from "../../db/queries.js";
import { runCeremony, concludeCeremony } from "../../services/naming-ceremony.js";

export async function namingCeremonyCommand(ctx: Context) {
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
    await ctx.reply("This chat isn't linked to a workspace yet. Use `/start` first.", {
      parse_mode: "Markdown",
    });
    return;
  }

  const existing = await getActiveCeremony();
  if (existing) {
    await ctx.reply(
      "A naming ceremony is already in progress! Use `/concludeceremony` to end it early.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const messageThreadId = ctx.message?.message_thread_id ?? workspaceLink.messageThreadId ?? null;

  try {
    await runCeremony(ctx.api, chatId, messageThreadId, userId);
  } catch (error) {
    console.error("Error starting naming ceremony:", error);
    await ctx.reply("Failed to start the naming ceremony. Please try again.");
  }
}

export async function concludeCeremonyCommand(ctx: Context) {
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

  const ceremony = await getActiveCeremony();
  if (!ceremony) {
    await ctx.reply("No naming ceremony is currently active.");
    return;
  }

  if (ceremony.telegramChatId !== chatId) {
    await ctx.reply("The active ceremony is in a different chat.");
    return;
  }

  try {
    await concludeCeremony(ctx.api, ceremony.id);
  } catch (error) {
    console.error("Error concluding naming ceremony:", error);
    await ctx.reply("Failed to conclude the ceremony. Please try again.");
  }
}
