import type { Context } from "grammy";
import {
  deleteUserLink,
  getUserLink,
} from "../../db/queries.js";

// Show user's link status (simplified - mapping is done by admin via /map)
export async function linkCommand(ctx: Context) {
  const userId = ctx.from?.id;
  const username = ctx.from?.username;

  if (!userId) {
    await ctx.reply("Could not identify user.");
    return;
  }

  const existingLink = await getUserLink(userId);
  if (existingLink) {
    await ctx.reply(
      `Your account is mapped to: *${existingLink.kanUserEmail}*\n\n` +
        "To unlink your account, use: `/unlinkme`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  await ctx.reply(
    `Your account hasn't been mapped yet.\n\n` +
      `Ask an admin to run:\n` +
      `\`/map @${username || userId} your@email.com\``,
    { parse_mode: "Markdown" }
  );
}

export async function unlinkMeCommand(ctx: Context) {
  const userId = ctx.from?.id;

  if (!userId) {
    await ctx.reply("Could not identify user.");
    return;
  }

  const existingLink = await getUserLink(userId);
  if (!existingLink) {
    await ctx.reply("Your account is not linked.");
    return;
  }

  await deleteUserLink(userId);
  await ctx.reply("Your Kan account has been unlinked.");
}
