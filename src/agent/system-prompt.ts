import { getBotIdentity } from "../services/bot-identity.js";
import { getWorkspaceLink, getDefaultBoardConfig, getAllUserLinks } from "../db/queries.js";
import { getSprintInfo } from "../utils/sprint.js";

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
  const workspace = await getWorkspaceLink(ctx.chatId);
  const defaultBoard = await getDefaultBoardConfig(ctx.chatId);
  const userLinks = await getAllUserLinks();
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
  if (workspace) {
    parts.push(`- Workspace: "${workspace.workspaceName}" (ID: ${workspace.workspacePublicId})`);
    if (workspace.messageThreadId) {
      parts.push(`- Reminder topic thread: ${workspace.messageThreadId}`);
    }
  } else {
    parts.push("- No workspace linked to this chat. An admin needs to link one first.");
  }

  parts.push(`- Sprint day: ${sprint.day}/14${sprint.isPlanningWindow ? " (PLANNING WINDOW — days 1-2)" : ""}${sprint.isBreak ? " (break day)" : ""}`);

  // User info
  parts.push(`- Requesting user: @${ctx.username || "unknown"} (user ID: ${ctx.userId}) — ${ctx.isAdmin ? "ADMIN" : "member"}`);

  // Find the requesting user's Kan mapping
  const callerMapping = userLinks.find(
    (l) =>
      l.telegramUserId === ctx.userId ||
      (ctx.username && l.telegramUsername === ctx.username)
  );
  if (callerMapping) {
    parts.push(`- User's Kan email: ${callerMapping.kanUserEmail}${callerMapping.workspaceMemberPublicId ? `, member ID: ${callerMapping.workspaceMemberPublicId}` : ""}`);
  } else {
    parts.push("- User has no Kan account mapping");
  }

  // Default board
  if (defaultBoard) {
    parts.push(`- Default board for new tasks: "${defaultBoard.boardName}" → "${defaultBoard.listName}" (board: ${defaultBoard.boardPublicId}, list: ${defaultBoard.listPublicId})`);
  } else {
    parts.push("- No default board/list configured for this chat");
  }
  parts.push("");

  // Team mappings
  if (userLinks.length > 0) {
    parts.push("## Team Mappings (Telegram → Kan)");
    for (const link of userLinks) {
      const username = link.telegramUsername ? `@${link.telegramUsername}` : `user:${link.telegramUserId}`;
      parts.push(`- ${username} → ${link.kanUserEmail}${link.workspaceMemberPublicId ? ` (${link.workspaceMemberPublicId})` : ""}`);
    }
    parts.push("");
  }

  // Reply context
  if (ctx.replyToText) {
    parts.push("## Reply Context");
    parts.push(`User is replying to a message${ctx.replyToUsername ? ` from @${ctx.replyToUsername}` : ""}:`);
    parts.push(`> ${ctx.replyToText.slice(0, 500)}`);
    parts.push("");
  }

  // Capabilities and guidelines
  parts.push(`## Your Capabilities

You have tools for:
- **Task management (Kan)**: search tasks, create/update/move cards, assign members, add comments, manage labels, checklists, boards, lists
- **Knowledge base (Outline)**: search/read/create/update wiki documents, manage collections
- **Bot config**: get/set workspace link, user mappings, default board, sprint info, bot identity

## Guidelines

1. **Telegram formatting**: Use Telegram Markdown (not MarkdownV2). Bold with *text*, italic with _text_, code with \`text\`, links with [text](url). Do NOT escape special characters.
2. **Stay in character** as ${identity.name} with your ${identity.tone} style.
3. **Creating tasks**: When asked to create a task, use the default board/list if configured. If not, ask the user which board to use. Always include the card link after creation: ${KAN_BASE_URL}/cards/{publicId}
4. **Assigning tasks**: Use team mappings to find workspace member public IDs. Use kan_toggle_card_member to assign.
5. **Admin-only operations**: Workspace link/unlink, user mapping CRUD, and set default board require admin status. If a non-admin tries, politely decline.
6. **Card links**: Always format as ${KAN_BASE_URL}/cards/{publicId}
7. **Be concise**: Keep responses short and actionable. Don't over-explain.
8. **Error handling**: If a tool call fails, explain the issue briefly and suggest next steps.
9. **Natural language**: Users won't use slash commands. Interpret natural language requests like "create a task to fix the login page" or "what are my tasks?" or "search the wiki for onboarding docs".
10. **Chat ID**: The current chat ID is ${ctx.chatId}. Use this when calling chat-config tools.`);

  return parts.join("\n");
}
