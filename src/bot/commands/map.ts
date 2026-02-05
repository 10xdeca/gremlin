import type { Context } from "grammy";
import { getServiceClient } from "../../api/kan-client.js";
import {
  createUserLink,
  deleteUserLink,
  getUserLink,
  getUserLinkByTelegramUsername,
  getAllWorkspaceLinks,
  updateUserLink,
} from "../../db/queries.js";

// Map a Telegram user to a Kan email (admin only, via DM)
export async function mapCommand(ctx: Context) {
  const adminId = ctx.from?.id;

  if (!adminId) {
    await ctx.reply("Could not identify user.");
    return;
  }

  // Must be in private chat
  if (ctx.chat?.type !== "private") {
    await ctx.reply(
      "Please use this command in a private message to me for security."
    );
    return;
  }

  const args = ctx.message?.text?.split(/\s+/).slice(1);

  if (!args || args.length < 2) {
    await ctx.reply(
      "Map a Telegram user to their Kan email:\n\n" +
        "`/map @username email@example.com`\n\n" +
        "Example:\n" +
        "`/map @nick nick@xdeca.com`\n\n" +
        "To see all mappings: `/map list`\n" +
        "To remove a mapping: `/map remove @username`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const subcommand = args[0].toLowerCase();

  // List all mappings
  if (subcommand === "list") {
    const { getAllUserLinks } = await import("../../db/queries.js");
    const userLinks = await getAllUserLinks();

    if (userLinks.length === 0) {
      await ctx.reply("No user mappings configured.");
      return;
    }

    const lines = userLinks.map(
      (link) =>
        `@${link.telegramUsername || link.telegramUserId} → ${link.kanUserEmail}`
    );
    await ctx.reply("*User Mappings:*\n\n" + lines.join("\n"), {
      parse_mode: "Markdown",
    });
    return;
  }

  // Remove a mapping
  if (subcommand === "remove") {
    const telegramUsername = args[1]?.replace(/^@/, "");
    if (!telegramUsername) {
      await ctx.reply("Usage: `/map remove @username`", { parse_mode: "Markdown" });
      return;
    }

    const existingLink = await getUserLinkByTelegramUsername(telegramUsername);
    if (!existingLink) {
      await ctx.reply(`No mapping found for @${telegramUsername}`);
      return;
    }

    await deleteUserLink(existingLink.telegramUserId);
    await ctx.reply(`Removed mapping for @${telegramUsername}`);
    return;
  }

  // Create/update a mapping: /map @username email
  const telegramUsername = args[0].replace(/^@/, "");
  const kanEmail = args[1].toLowerCase();

  // Validate email format
  if (!kanEmail.includes("@")) {
    await ctx.reply("Invalid email format. Usage: `/map @username email@example.com`", {
      parse_mode: "Markdown",
    });
    return;
  }

  // Verify the email exists in a linked workspace
  try {
    const client = getServiceClient();
    const workspaceLinks = await getAllWorkspaceLinks();

    if (workspaceLinks.length === 0) {
      await ctx.reply(
        "No workspaces are linked yet. Use `/start` in a group to link a workspace first."
      );
      return;
    }

    let foundMember = null;
    let foundWorkspace = null;

    for (const wsLink of workspaceLinks) {
      try {
        const workspace = await client.getWorkspace(wsLink.workspacePublicId);
        const member = workspace.members.find(
          (m) => m.email.toLowerCase() === kanEmail && m.status === "active"
        );
        if (member) {
          foundMember = member;
          foundWorkspace = workspace;
          break;
        }
      } catch {
        // Skip workspaces we can't access
        continue;
      }
    }

    if (!foundMember) {
      await ctx.reply(
        `Email *${kanEmail}* not found as an active member in any linked workspace.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Check if this Telegram username is already mapped
    const existingByUsername = await getUserLinkByTelegramUsername(telegramUsername);

    if (existingByUsername) {
      // Update existing mapping
      await updateUserLink(existingByUsername.telegramUserId, {
        kanUserEmail: kanEmail,
        workspaceMemberPublicId: foundMember.publicId,
      });
      await ctx.reply(
        `Updated mapping:\n` +
          `@${telegramUsername} → *${kanEmail}*\n` +
          `Workspace: ${foundWorkspace!.name}`,
        { parse_mode: "Markdown" }
      );
    } else {
      // Create new mapping (we don't know their Telegram user ID yet)
      // We'll use a placeholder ID and update when they interact with the bot
      // Actually, we need the Telegram user ID. Let's store by username and resolve later.

      // For now, create with a fake ID that we'll update when we see them
      // This is a workaround - ideally we'd resolve the username to ID
      const placeholderId = -Math.abs(hashCode(telegramUsername));

      await createUserLink({
        telegramUserId: placeholderId,
        telegramUsername: telegramUsername,
        kanUserEmail: kanEmail,
        workspaceMemberPublicId: foundMember.publicId,
        createdByTelegramUserId: adminId,
      });

      await ctx.reply(
        `Mapped:\n` +
          `@${telegramUsername} → *${kanEmail}*\n` +
          `Workspace: ${foundWorkspace!.name}`,
        { parse_mode: "Markdown" }
      );
    }
  } catch (error) {
    console.error("Error in map command:", error);
    await ctx.reply(
      "Error verifying email. Make sure KAN_SERVICE_API_KEY is configured."
    );
  }
}

// Simple hash function for generating placeholder IDs
function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash;
}
