import { registerCustomTool } from "../agent/tool-registry.js";
import {
  getUserLink,
  getUserLinkByTelegramUsername,
  createUserLink,
  updateUserLink,
  deleteUserLink,
  getAllUserLinks,
} from "../db/queries.js";

/** Register user mapping tools. */
export function registerUserMappingTools(): void {
  registerCustomTool({
    name: "get_user_mapping",
    description:
      "Look up the Kan account mapping for a Telegram user, by user ID or username.",
    inputSchema: {
      type: "object",
      properties: {
        telegram_user_id: { type: "number", description: "Telegram user ID" },
        telegram_username: { type: "string", description: "Telegram username (without @)" },
      },
    },
    handler: async (args) => {
      let link = null;
      if (args.telegram_user_id) {
        link = await getUserLink(args.telegram_user_id as number);
      }
      if (!link && args.telegram_username) {
        link = await getUserLinkByTelegramUsername(args.telegram_username as string);
      }
      if (!link) {
        return JSON.stringify({ found: false });
      }
      return JSON.stringify({
        found: true,
        telegramUserId: link.telegramUserId,
        telegramUsername: link.telegramUsername,
        kanUserEmail: link.kanUserEmail,
        workspaceMemberPublicId: link.workspaceMemberPublicId,
      });
    },
  });

  registerCustomTool({
    name: "create_user_mapping",
    description:
      "Map a Telegram user to their Kan workspace account. Admin only. Provide the Telegram username and Kan email. Optionally provide workspace member public ID.",
    inputSchema: {
      type: "object",
      properties: {
        telegram_user_id: { type: "number", description: "Telegram user ID (use 0 if unknown)" },
        telegram_username: { type: "string", description: "Telegram username (without @)" },
        kan_user_email: { type: "string", description: "Kan account email" },
        workspace_member_public_id: {
          type: "string",
          description: "Kan workspace member public ID (optional but recommended for task assignment)",
        },
        admin_user_id: { type: "number", description: "Telegram user ID of admin creating the mapping" },
      },
      required: ["telegram_username", "kan_user_email"],
    },
    handler: async (args) => {
      const telegramUserId = (args.telegram_user_id as number) || 0;
      const existing = await getUserLink(telegramUserId);
      if (existing) {
        const updateData: Parameters<typeof updateUserLink>[1] = {
          telegramUsername: args.telegram_username as string,
          kanUserEmail: args.kan_user_email as string,
        };
        if (args.workspace_member_public_id) {
          updateData.workspaceMemberPublicId = args.workspace_member_public_id as string;
        }
        await updateUserLink(telegramUserId, updateData);
        return JSON.stringify({ success: true, action: "updated" });
      }

      await createUserLink({
        telegramUserId,
        telegramUsername: args.telegram_username as string,
        kanUserEmail: args.kan_user_email as string,
        workspaceMemberPublicId: args.workspace_member_public_id as string | undefined,
        createdByTelegramUserId: args.admin_user_id as number | undefined,
      });
      return JSON.stringify({ success: true, action: "created" });
    },
  });

  registerCustomTool({
    name: "remove_user_mapping",
    description: "Remove a Telegram-to-Kan user mapping. Admin only.",
    inputSchema: {
      type: "object",
      properties: {
        telegram_user_id: { type: "number", description: "Telegram user ID to unlink" },
      },
      required: ["telegram_user_id"],
    },
    handler: async (args) => {
      await deleteUserLink(args.telegram_user_id as number);
      return JSON.stringify({ success: true });
    },
  });

  registerCustomTool({
    name: "list_user_mappings",
    description:
      "List all Telegram-to-Kan user mappings. Returns an array of { telegramUsername, kanUserEmail, workspaceMemberPublicId }.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      const links = await getAllUserLinks();
      return JSON.stringify(
        links.map((l) => ({
          telegramUserId: l.telegramUserId,
          telegramUsername: l.telegramUsername,
          kanUserEmail: l.kanUserEmail,
          workspaceMemberPublicId: l.workspaceMemberPublicId,
        }))
      );
    },
  });
}
