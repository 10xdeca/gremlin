import { registerCustomTool } from "../agent/tool-registry.js";
import {
  getWorkspaceLink,
  createWorkspaceLink,
  deleteWorkspaceLink,
  updateWorkspaceLinkTopic,
  updateWorkspaceLinkSocialTopic,
} from "../db/queries.js";
import { invalidateTopicCache } from "../utils/topic-cache.js";

/** Parse admin user IDs from environment. */
const ADMIN_USER_IDS: Set<number> = new Set(
  (process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !isNaN(id))
);

/** Register chat configuration tools. */
export function registerChatConfigTools(): void {
  registerCustomTool({
    name: "get_chat_config",
    description:
      "Get the current chat's workspace link configuration. Returns workspace info and topic thread IDs.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "Telegram chat ID" },
      },
      required: ["chat_id"],
    },
    handler: async (args) => {
      const chatId = args.chat_id as number;
      const link = await getWorkspaceLink(chatId);

      return JSON.stringify({
        workspace: link
          ? {
              workspacePublicId: link.workspacePublicId,
              workspaceName: link.workspaceName,
              messageThreadId: link.messageThreadId,
              socialThreadId: link.socialThreadId,
            }
          : null,
      });
    },
  });

  registerCustomTool({
    name: "link_workspace",
    description:
      "Link this Telegram chat to a Kan workspace. Admin only. Provide the workspace public ID and name.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "Telegram chat ID" },
        workspace_public_id: { type: "string", description: "Kan workspace public ID" },
        workspace_name: { type: "string", description: "Workspace name" },
        user_id: { type: "number", description: "Telegram user ID of admin performing the link" },
      },
      required: ["chat_id", "workspace_public_id", "workspace_name", "user_id"],
    },
    handler: async (args) => {
      const existing = await getWorkspaceLink(args.chat_id as number);
      if (existing) {
        await deleteWorkspaceLink(args.chat_id as number);
      }
      await createWorkspaceLink({
        telegramChatId: args.chat_id as number,
        workspacePublicId: args.workspace_public_id as string,
        workspaceName: args.workspace_name as string,
        createdByTelegramUserId: args.user_id as number,
      });
      return JSON.stringify({ success: true, message: `Linked to workspace "${args.workspace_name}"` });
    },
  });

  registerCustomTool({
    name: "unlink_workspace",
    description: "Unlink this Telegram chat from its Kan workspace. Admin only.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "Telegram chat ID" },
      },
      required: ["chat_id"],
    },
    handler: async (args) => {
      await deleteWorkspaceLink(args.chat_id as number);
      return JSON.stringify({ success: true, message: "Workspace unlinked" });
    },
  });

  registerCustomTool({
    name: "set_reminder_topic",
    description:
      "Set the Telegram topic (message thread) where the bot should post reminders. Admin only. Use 0 or null to clear.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "Telegram chat ID" },
        user_id: { type: "number", description: "Telegram user ID of the requesting user" },
        message_thread_id: {
          type: ["number", "null"],
          description: "Telegram message thread ID, or null to clear",
        },
      },
      required: ["chat_id", "user_id"],
    },
    handler: async (args) => {
      if (!ADMIN_USER_IDS.has(args.user_id as number)) {
        return JSON.stringify({ error: "Only admins can change topic settings" });
      }
      const chatId = args.chat_id as number;
      const threadId = args.message_thread_id as number | null;
      await updateWorkspaceLinkTopic(chatId, threadId || null);
      invalidateTopicCache(chatId);
      return JSON.stringify({ success: true, message: threadId ? `Topic set to thread ${threadId}` : "Topic cleared" });
    },
  });

  registerCustomTool({
    name: "set_social_topic",
    description:
      "Set the Telegram topic (message thread) for Gremlin's Corner — the social/casual topic where the bot chats freely. Admin only. Use 0 or null to clear.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "Telegram chat ID" },
        user_id: { type: "number", description: "Telegram user ID of the requesting user" },
        message_thread_id: {
          type: ["number", "null"],
          description: "Telegram message thread ID for the social topic, or null to clear",
        },
      },
      required: ["chat_id", "user_id"],
    },
    handler: async (args) => {
      if (!ADMIN_USER_IDS.has(args.user_id as number)) {
        return JSON.stringify({ error: "Only admins can change topic settings" });
      }
      const chatId = args.chat_id as number;
      const threadId = args.message_thread_id as number | null;
      await updateWorkspaceLinkSocialTopic(chatId, threadId || null);
      invalidateTopicCache(chatId);
      return JSON.stringify({ success: true, message: threadId ? `Social topic set to thread ${threadId}` : "Social topic cleared" });
    },
  });

}
