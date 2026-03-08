import type { Api } from "grammy";
import { registerCustomTool } from "../agent/tool-registry.js";
import { getAllUserLinks } from "../db/queries.js";

/**
 * Register the direct message tool.
 * Requires the bot API instance to send messages.
 */
export function registerDirectMessageTools(api: Api): void {
  registerCustomTool({
    name: "send_dm",
    description:
      "Send a direct message to a Telegram user. The user must have previously started a " +
      "conversation with the bot (Telegram requirement). Use get_user_mapping or " +
      "list_user_mappings to find the user's Telegram ID first.",
    inputSchema: {
      type: "object",
      properties: {
        telegram_user_id: {
          type: "number",
          description: "Telegram user ID to send the DM to",
        },
        text: {
          type: "string",
          description: "Message text (Telegram Markdown supported)",
        },
      },
      required: ["telegram_user_id", "text"],
    },
    handler: async (args) => {
      const userId = args.telegram_user_id as number;
      const text = args.text as string;

      try {
        await api.sendMessage(userId, text, {
          parse_mode: "Markdown",
          link_preview_options: { is_disabled: true },
        });
        return JSON.stringify({ success: true, message: `DM sent to user ${userId}` });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // Telegram returns 403 if the user hasn't started a conversation with the bot
        if (errMsg.includes("403") || errMsg.includes("bot was blocked") || errMsg.includes("chat not found")) {
          return JSON.stringify({
            success: false,
            error: "Can't DM this user — they haven't started a conversation with me yet. They need to message me directly first.",
          });
        }
        return JSON.stringify({ success: false, error: errMsg });
      }
    },
  });
}
