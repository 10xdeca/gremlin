import { registerCustomTool } from "../agent/tool-registry.js";
import {
  getStandupConfig,
  upsertStandupConfig,
  getActiveStandupSession,
  upsertStandupResponse,
  getStandupResponses,
  getAllUserLinks,
  getWorkspaceLink,
} from "../db/queries.js";
import { getTodayInTimezone } from "../utils/timezone.js";
import { mcpManager } from "../agent/mcp-manager.js";

/** Register standup management tools. */
export function registerStandupTools(): void {
  registerCustomTool({
    name: "get_standup_config",
    description:
      "Get the standup configuration for this chat. Returns schedule, timezone, and skip settings.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "Telegram chat ID" },
      },
      required: ["chat_id"],
    },
    handler: async (args) => {
      const chatId = args.chat_id as number;
      const config = await getStandupConfig(chatId);
      return JSON.stringify(config || { configured: false });
    },
  });

  registerCustomTool({
    name: "set_standup_config",
    description:
      "Configure daily standups for this chat. Admin only. Set prompt/summary hours, timezone, and skip rules.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "Telegram chat ID" },
        enabled: { type: "boolean", description: "Enable or disable standups" },
        prompt_hour: {
          type: "number",
          description: "Hour (0-23) to post the standup prompt in the configured timezone",
        },
        summary_hour: {
          type: "number",
          description: "Hour (0-23) to post the standup summary in the configured timezone",
        },
        timezone: {
          type: "string",
          description: "IANA timezone (e.g. 'Australia/Sydney', 'America/New_York')",
        },
        skip_break_days: {
          type: "boolean",
          description: "Skip standups on sprint break days",
        },
        skip_weekends: {
          type: "boolean",
          description: "Skip standups on weekends",
        },
      },
      required: ["chat_id"],
    },
    handler: async (args) => {
      await upsertStandupConfig({
        telegramChatId: args.chat_id as number,
        ...(args.enabled !== undefined ? { enabled: args.enabled as boolean } : {}),
        ...(args.prompt_hour !== undefined ? { promptHour: args.prompt_hour as number } : {}),
        ...(args.summary_hour !== undefined ? { summaryHour: args.summary_hour as number } : {}),
        ...(args.timezone !== undefined ? { timezone: args.timezone as string } : {}),
        ...(args.skip_break_days !== undefined ? { skipBreakDays: args.skip_break_days as boolean } : {}),
        ...(args.skip_weekends !== undefined ? { skipWeekends: args.skip_weekends as boolean } : {}),
      });
      const updated = await getStandupConfig(args.chat_id as number);
      return JSON.stringify({ success: true, config: updated });
    },
  });

  registerCustomTool({
    name: "save_standup_response",
    description:
      "Save a user's standup response. Call this when a user shares what they worked on, what they're doing next, or mentions blockers during an active standup session. Parses their update into yesterday/today/blockers fields.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "Telegram chat ID" },
        user_id: { type: "number", description: "Telegram user ID of the responder" },
        username: { type: "string", description: "Telegram username of the responder" },
        yesterday: {
          type: "string",
          description: "What the user worked on yesterday/recently",
        },
        today: {
          type: "string",
          description: "What the user plans to work on today",
        },
        blockers: {
          type: "string",
          description: "Any blockers or issues the user mentioned",
        },
        raw_message: {
          type: "string",
          description: "The original message text",
        },
      },
      required: ["chat_id", "user_id"],
    },
    handler: async (args) => {
      const chatId = args.chat_id as number;
      const config = await getStandupConfig(chatId);
      const timezone = config?.timezone ?? "Australia/Sydney";
      const today = getTodayInTimezone(timezone);

      const session = await getActiveStandupSession(chatId, today);
      if (!session || session.status !== "active") {
        return JSON.stringify({
          success: false,
          error: "No active standup session for today",
        });
      }

      await upsertStandupResponse({
        sessionId: session.id,
        telegramUserId: args.user_id as number,
        telegramUsername: (args.username as string) || null,
        yesterday: (args.yesterday as string) || null,
        today: (args.today as string) || null,
        blockers: (args.blockers as string) || null,
        rawMessage: (args.raw_message as string) || null,
      });

      return JSON.stringify({ success: true, message: "Standup response saved" });
    },
  });

  registerCustomTool({
    name: "get_standup_status",
    description:
      "Get today's standup status — who has responded and who hasn't. Useful for checking progress.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "Telegram chat ID" },
      },
      required: ["chat_id"],
    },
    handler: async (args) => {
      const chatId = args.chat_id as number;
      const config = await getStandupConfig(chatId);
      if (!config || !config.enabled) {
        return JSON.stringify({ active: false, message: "Standups not configured or disabled" });
      }

      const today = getTodayInTimezone(config.timezone);
      const session = await getActiveStandupSession(chatId, today);
      if (!session) {
        return JSON.stringify({ active: false, message: "No standup session for today" });
      }

      const responses = await getStandupResponses(session.id);
      const respondedUserIds = new Set(responses.map((r) => r.telegramUserId));

      const responded = responses.map((r) => ({
        userId: r.telegramUserId,
        username: r.telegramUsername,
        yesterday: r.yesterday,
        today: r.today,
        blockers: r.blockers,
      }));

      // Scope "missing" list to workspace members
      const wsLink = await getWorkspaceLink(chatId);
      const workspaceUsernames = await getWorkspaceScopedUserLinks(wsLink?.workspacePublicId);
      const missing = workspaceUsernames
        .filter((u) => !respondedUserIds.has(u.telegramUserId))
        .map((u) => ({
          userId: u.telegramUserId,
          username: u.telegramUsername,
        }));

      return JSON.stringify({
        active: true,
        date: today,
        status: session.status,
        responded,
        missing,
      });
    },
  });
}

/** Get user links scoped to a workspace's active members. */
async function getWorkspaceScopedUserLinks(workspacePublicId: string | undefined) {
  if (!workspacePublicId) return [];

  try {
    const data = JSON.parse(
      await mcpManager.callTool("kan_get_workspace", { workspace_id: workspacePublicId })
    ) as { members?: Array<{ email: string; status: string }> };
    const activeEmails = new Set(
      (data.members || []).filter((m) => m.status === "active").map((m) => m.email.toLowerCase())
    );

    const userLinks = await getAllUserLinks();
    return userLinks.filter(
      (u) => u.telegramUsername && activeEmails.has(u.kanUserEmail.toLowerCase())
    );
  } catch {
    return [];
  }
}
