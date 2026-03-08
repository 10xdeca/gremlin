import { registerCustomTool } from "../agent/tool-registry.js";
import {
  getWorkspaceLink,
  createWorkspaceLink,
  deleteWorkspaceLink,
  updateWorkspaceLinkTopic,
  updateWorkspaceLinkSocialTopic,
  getDefaultBoardConfig,
  upsertDefaultBoardConfig,
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
      "Get the current chat's workspace link and default board/list configuration. Returns workspace info, topic thread ID, and default board/list for card creation.",
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
      const defaultBoard = await getDefaultBoardConfig(chatId);

      return JSON.stringify({
        workspace: link
          ? {
              workspacePublicId: link.workspacePublicId,
              workspaceName: link.workspaceName,
              messageThreadId: link.messageThreadId,
              socialThreadId: link.socialThreadId,
            }
          : null,
        defaultBoard: defaultBoard
          ? {
              boardPublicId: defaultBoard.boardPublicId,
              listPublicId: defaultBoard.listPublicId,
              boardName: defaultBoard.boardName,
              listName: defaultBoard.listName,
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

  registerCustomTool({
    name: "set_default_board",
    description:
      "Set the default board and list for new card creation in this chat. Admin only.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "Telegram chat ID" },
        board_public_id: { type: "string", description: "Board public ID" },
        list_public_id: { type: "string", description: "List public ID" },
        board_name: { type: "string", description: "Board name (for display)" },
        list_name: { type: "string", description: "List name (for display)" },
      },
      required: ["chat_id", "board_public_id", "list_public_id", "board_name", "list_name"],
    },
    handler: async (args) => {
      await upsertDefaultBoardConfig({
        telegramChatId: args.chat_id as number,
        boardPublicId: args.board_public_id as string,
        listPublicId: args.list_public_id as string,
        boardName: args.board_name as string,
        listName: args.list_name as string,
      });
      return JSON.stringify({
        success: true,
        message: `Default set to "${args.board_name}" → "${args.list_name}"`,
      });
    },
  });
}
