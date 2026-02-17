import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { getWorkspaceLink, getUserLinkByTelegramUsername } from "../../db/queries.js";
import { shouldCheckMessage, detectTask, recordCooldown, isBotMention } from "../../services/task-detector.js";
import { extractMentions, resolveMentionsToMembers } from "../../utils/mentions.js";
import { startNewTaskFlow } from "../callbacks/newtask-flow.js";
import { storeSuggestion } from "../callbacks/task-suggestion.js";

const INFRA_ASSIGNEE_USERNAME = process.env.INFRA_ASSIGNEE_USERNAME;

/**
 * Message listener registered via bot.on("message:text").
 * Handles two paths:
 * 1. @mention path — bot is @mentioned directly, bypasses cooldown/min-length guards
 * 2. Passive scanning path — unchanged guards, uses interactive flow for creation
 */
export async function messageListener(ctx: Context) {
  const chatId = ctx.chat?.id;
  const text = ctx.message?.text;
  const isBot = ctx.from?.is_bot ?? false;

  if (!chatId || !text) return;

  // Skip bot messages always
  if (isBot) return;

  // Skip private chats
  if (ctx.chat?.type === "private") return;

  // Skip if workspace not linked
  const workspaceLink = await getWorkspaceLink(chatId);
  if (!workspaceLink) return;

  const botUsername = ctx.me?.username;
  const isMention = isBotMention(text, botUsername);

  if (isMention) {
    await handleBotMention(ctx, chatId, text, botUsername, workspaceLink.workspacePublicId);
  } else {
    await handlePassiveScan(ctx, chatId, text, botUsername, workspaceLink.workspacePublicId);
  }
}

/**
 * @mention path: bot is directly @mentioned.
 * Bypasses cooldown and min-length guards. Uses LLM to extract task intent,
 * then starts the interactive flow.
 */
async function handleBotMention(
  ctx: Context,
  chatId: number,
  text: string,
  botUsername: string | undefined,
  workspacePublicId: string,
) {
  // Skip commands (shouldn't happen with @mention, but guard anyway)
  if (text.startsWith("/")) return;

  const detection = await detectTask(text);

  // If the LLM says it's not a task, silently ignore
  if (!detection.isTask) return;

  try {
    // Resolve @mentions from the message (excluding bot username)
    const { usernames } = extractMentions(text, botUsername);
    const { resolved, unresolved } = await resolveMentionsToMembers(usernames);
    const memberPublicIds = resolved.map((r) => r.memberPublicId);
    const memberNames = resolved.map((r) => `@${r.username}`);

    // Auto-add infra assignee for infrastructure tasks
    if (detection.isInfrastructure && INFRA_ASSIGNEE_USERNAME) {
      const infraLink = await getUserLinkByTelegramUsername(INFRA_ASSIGNEE_USERNAME);
      if (infraLink?.workspaceMemberPublicId) {
        if (!memberPublicIds.includes(infraLink.workspaceMemberPublicId)) {
          memberPublicIds.push(infraLink.workspaceMemberPublicId);
          memberNames.push(`@${INFRA_ASSIGNEE_USERNAME}`);
        }
      }
    }

    const result = await startNewTaskFlow({
      title: detection.title,
      chatId,
      workspacePublicId,
      mentionsProvided: memberPublicIds.length > 0,
      resolvedMembers: memberPublicIds.map((id, i) => ({
        memberPublicId: id,
        displayName: memberNames[i],
      })),
      unresolvedMentions: unresolved,
    });

    if (result.type === "created") {
      await ctx.reply(result.text, {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true },
        reply_parameters: { message_id: ctx.message!.message_id },
      });
    } else {
      await ctx.reply(result.text, {
        parse_mode: "Markdown",
        reply_markup: result.keyboard,
        reply_parameters: { message_id: ctx.message!.message_id },
      });
    }

    recordCooldown(chatId);
  } catch (error) {
    console.error("Error handling @mention task:", error);
  }
}

/**
 * Passive scanning path: no @mention.
 * Uses standard guards (cooldown, min-length, etc.).
 * Direct requests → interactive flow. Suggestions → Create/Dismiss with flow on Create.
 */
async function handlePassiveScan(
  ctx: Context,
  chatId: number,
  text: string,
  botUsername: string | undefined,
  workspacePublicId: string,
) {
  // Guards: skip commands, short messages, cooldown
  if (!shouldCheckMessage(chatId, text, false)) return;

  const detection = await detectTask(text);

  // Only surface medium/high confidence detections
  if (!detection.isTask || detection.confidence === "low") return;

  recordCooldown(chatId);

  try {
    // Resolve @mentions from the message
    const { usernames } = extractMentions(text, botUsername);
    const { resolved } = await resolveMentionsToMembers(usernames);
    const memberPublicIds = resolved.map((r) => r.memberPublicId);
    const memberNames = resolved.map((r) => `@${r.username}`);

    // Auto-add infra assignee for infrastructure tasks
    if (detection.isInfrastructure && INFRA_ASSIGNEE_USERNAME) {
      const infraLink = await getUserLinkByTelegramUsername(INFRA_ASSIGNEE_USERNAME);
      if (infraLink?.workspaceMemberPublicId) {
        if (!memberPublicIds.includes(infraLink.workspaceMemberPublicId)) {
          memberPublicIds.push(infraLink.workspaceMemberPublicId);
          memberNames.push(`@${INFRA_ASSIGNEE_USERNAME}`);
        }
      }
    }

    if (detection.isDirectRequest) {
      // Direct request → start interactive flow immediately
      const result = await startNewTaskFlow({
        title: detection.title,
        chatId,
        workspacePublicId,
        mentionsProvided: memberPublicIds.length > 0,
        resolvedMembers: memberPublicIds.map((id, i) => ({
          memberPublicId: id,
          displayName: memberNames[i],
        })),
        unresolvedMentions: [],
      });

      if (result.type === "created") {
        await ctx.reply(result.text, {
          parse_mode: "Markdown",
          link_preview_options: { is_disabled: true },
          reply_parameters: { message_id: ctx.message!.message_id },
        });
      } else {
        await ctx.reply(result.text, {
          parse_mode: "Markdown",
          reply_markup: result.keyboard,
          reply_parameters: { message_id: ctx.message!.message_id },
        });
      }
    } else {
      // Implicit suggestion: show Create/Dismiss buttons
      const suggestionId = storeSuggestion({
        title: detection.title,
        workspacePublicId,
        memberPublicIds,
        assigneeNames: memberNames,
        chatId,
      });

      let suggestionText = `Detected a task:\n\n*${detection.title}*`;
      if (memberNames.length > 0) {
        suggestionText += `\nAssign to: ${memberNames.join(", ")}`;
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
  }
}
