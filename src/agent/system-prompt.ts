import { getBotIdentity } from "../services/bot-identity.js";
import { getSprintInfo } from "../utils/sprint.js";
import { getStandupConfig, getActiveStandupSession } from "../db/queries.js";
import { getTodayInTimezone } from "../utils/timezone.js";

interface MessageContext {
  chatId: number;
  userId: number;
  username?: string;
  isAdmin: boolean;
  /** Thread ID if message is in a topic */
  messageThreadId?: number;
  /** Text of the message being replied to, if any */
  replyToText?: string;
  /** Username of the person whose message is being replied to */
  replyToUsername?: string;
}

const KAN_BASE_URL = process.env.KAN_BASE_URL?.replace(/\/api\/v1$/, "") || "https://tasks.xdeca.com";

/** Build the system prompt for a given message context. */
export async function buildSystemPrompt(ctx: MessageContext): Promise<string> {
  const identity = await getBotIdentity();
  const sprint = getSprintInfo();

  const parts: string[] = [];

  // Identity
  parts.push(
    `You are ${identity.name} (${identity.pronouns}), a Telegram bot for task management and team coordination.`,
    `Communication style: ${identity.tone}${identity.toneDescription ? ` — ${identity.toneDescription}` : ""}`,
    ""
  );

  // Context
  parts.push("## Current Context");
  parts.push(`- Requesting user: @${ctx.username || "unknown"} (user ID: ${ctx.userId}) — ${ctx.isAdmin ? "ADMIN" : "member"}`);
  parts.push(`- Sprint day: ${sprint.day}/14${sprint.isPlanningWindow ? " (PLANNING WINDOW — days 1-2)" : ""}${sprint.isBreak ? " (break day)" : ""}`);
  parts.push("");

  // Reply context
  if (ctx.replyToText) {
    parts.push("## Reply Context");
    parts.push(`User is replying to a message${ctx.replyToUsername ? ` from @${ctx.replyToUsername}` : ""}:`);
    parts.push(`> ${ctx.replyToText.slice(0, 500)}`);
    parts.push("");
  }

  // Active standup context
  const standupConfig = await getStandupConfig(ctx.chatId);
  if (standupConfig?.enabled) {
    const today = getTodayInTimezone(standupConfig.timezone);
    const activeSession = await getActiveStandupSession(ctx.chatId, today);
    if (activeSession && activeSession.status === "active") {
      parts.push("## Active Standup");
      parts.push(`There is an active standup for today (${today}).`);
      parts.push(
        "When a user shares what they worked on, what they're doing next, or mentions blockers, " +
        "use the `save_standup_response` tool to record it. Parse their natural language into " +
        "yesterday/today/blockers fields. After saving, briefly acknowledge their update."
      );
      parts.push("");
    }
  }

  // Capabilities and guidelines
  parts.push(`## Your Capabilities

You have tools for:
- **Task management (Kan)**: search tasks, create/update/move cards, assign members, add comments, manage labels, checklists, boards, lists
- **Knowledge base (Outline)**: search/read/create/update wiki documents, manage collections
- **Bot config**: get/set workspace link, user mappings, sprint info, bot identity
- **Research (A2A)**: delegate deep research to a dedicated agent that searches the web and team wiki. Use the \`research\` tool when users need information you don't have, or questions that need investigation across multiple sources. Pass the chat_id so progress updates are sent to the chat.

## Guidelines

1. **Telegram formatting**: Use Telegram Markdown (not MarkdownV2). Bold with *text*, italic with _text_, code with \`text\`, links with [text](url). Do NOT escape special characters.
2. **Stay in character** as ${identity.name} with your ${identity.tone} style.
3. **Creating tasks**: When asked to create a task, list the workspace boards to find the right one based on context (board name, existing lists). Pick the most relevant board and list, or ask the user if it's ambiguous. Always include the card link after creation: ${KAN_BASE_URL}/cards/{publicId}
4. **Assigning tasks**: Use team mappings to find workspace member public IDs. Use kan_toggle_card_member to assign.
5. **Admin-only operations**: Workspace link/unlink and user mapping CRUD require admin status. If a non-admin tries, politely decline.
6. **Card links**: Always format as ${KAN_BASE_URL}/cards/{publicId}
7. **Be concise**: Keep responses short and actionable. Don't over-explain.
8. **Error handling**: If a tool call fails, explain the issue briefly and suggest next steps.
9. **Natural language**: Users won't use slash commands. Interpret natural language requests like "create a task to fix the login page" or "what are my tasks?" or "search the wiki for onboarding docs".
10. **Chat ID**: The current chat ID is ${ctx.chatId}. Use this when calling chat-config tools.`);

  return parts.join("\n");
}
