import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { getWorkspaceLink, getDefaultBoardConfig, getUserLinkByTelegramUsername } from "../../db/queries.js";
import { getServiceClient } from "../../api/kan-client.js";
import { shouldCheckMessage, detectTask, recordCooldown } from "../../services/task-detector.js";
import { extractMentions, resolveMentionsToMembers } from "../../utils/mentions.js";
import { storeSuggestion } from "../callbacks/task-suggestion.js";

const KAN_BASE_URL = process.env.KAN_BASE_URL || "https://tasks.xdeca.com";
const INFRA_ASSIGNEE_USERNAME = process.env.INFRA_ASSIGNEE_USERNAME;

/**
 * Message listener registered via bot.on("message:text").
 * Detects task-like messages and either creates cards directly or suggests creation.
 */
export async function messageListener(ctx: Context) {
  const chatId = ctx.chat?.id;
  const text = ctx.message?.text;
  const isBot = ctx.from?.is_bot ?? false;

  if (!chatId || !text) return;

  // Skip private chats
  if (ctx.chat?.type === "private") return;

  // Skip if workspace not linked
  const workspaceLink = await getWorkspaceLink(chatId);
  if (!workspaceLink) return;

  // Guards: skip commands, short messages, bot messages, cooldown
  if (!shouldCheckMessage(chatId, text, isBot)) return;

  // Record cooldown before the LLM call to prevent concurrent checks
  recordCooldown(chatId);

  const detection = await detectTask(text);

  // Only surface medium/high confidence detections
  if (!detection.isTask || detection.confidence === "low") return;

  const client = getServiceClient();

  try {
    // Resolve target list
    const config = await getDefaultBoardConfig(chatId);
    let listPublicId: string;
    let listName: string;
    let boardName: string;

    if (config) {
      listPublicId = config.listPublicId;
      listName = config.listName;
      boardName = config.boardName;
    } else {
      const boards = await client.getBoards(workspaceLink.workspacePublicId);
      if (!boards.length) return;
      const board = boards[0];
      const list = await client.findBacklogOrTodoList(board.publicId);
      if (!list) return;
      listPublicId = list.publicId;
      listName = list.name;
      boardName = board.name;
    }

    // Resolve @mentions from the message
    const botUsername = ctx.me?.username;
    const { usernames } = extractMentions(text, botUsername);
    const { resolved } = await resolveMentionsToMembers(usernames);
    const memberPublicIds = resolved.map((r) => r.memberPublicId);
    const assigneeNames = resolved.map((r) => `@${r.username}`);

    // Auto-add infra assignee for infrastructure tasks
    if (detection.isInfrastructure && INFRA_ASSIGNEE_USERNAME) {
      const infraLink = await getUserLinkByTelegramUsername(INFRA_ASSIGNEE_USERNAME);
      if (infraLink?.workspaceMemberPublicId) {
        // Avoid duplicates
        if (!memberPublicIds.includes(infraLink.workspaceMemberPublicId)) {
          memberPublicIds.push(infraLink.workspaceMemberPublicId);
          assigneeNames.push(`@${INFRA_ASSIGNEE_USERNAME}`);
        }
      }
    }

    if (detection.isDirectRequest) {
      // Direct request: create the card immediately
      const card = await client.createCard(listPublicId, {
        title: detection.title,
        memberPublicIds: memberPublicIds.length > 0 ? memberPublicIds : undefined,
      });

      const cardUrl = `${KAN_BASE_URL}/card/${card.publicId}`;
      let response = `Task created in *${boardName}* → ${listName}:\n\n` +
        `*${detection.title}*\n` +
        `[Open in Kan](${cardUrl})`;

      if (assigneeNames.length > 0) {
        response += `\n\nAssigned to: ${assigneeNames.join(", ")}`;
      }

      await ctx.reply(response, {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true },
        reply_parameters: { message_id: ctx.message!.message_id },
      });
    } else {
      // Implicit suggestion: ask with inline buttons
      const suggestionId = storeSuggestion({
        title: detection.title,
        listPublicId,
        boardName,
        listName,
        memberPublicIds,
        assigneeNames,
        chatId,
      });

      let suggestionText = `Detected a task:\n\n*${detection.title}*\n→ ${boardName} / ${listName}`;
      if (assigneeNames.length > 0) {
        suggestionText += `\nAssign to: ${assigneeNames.join(", ")}`;
      }

      const keyboard = new InlineKeyboard()
        .text("Create task", `task:create:${suggestionId}`)
        .text("Dismiss", `task:dismiss:${suggestionId}`);

      await ctx.reply(suggestionText, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
        reply_parameters: { message_id: ctx.message!.message_id },
      });
    }
  } catch (error) {
    console.error("Error in message listener:", error);
    // Silently fail - don't disrupt chat with error messages
  }
}
