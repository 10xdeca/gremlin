import type { Context } from "grammy";
import { nanoid } from "nanoid";
import { startNewTaskFlow } from "./newtask-flow.js";

export interface PendingSuggestion {
  id: string;
  title: string;
  workspacePublicId: string;
  memberPublicIds: string[];
  /** Names for display (e.g. "@nick") */
  assigneeNames: string[];
  chatId: number;
  createdAt: number;
}

// In-memory store with 1-hour TTL
const pendingSuggestions = new Map<string, PendingSuggestion>();
const TTL_MS = 60 * 60 * 1000; // 1 hour

export function storeSuggestion(suggestion: Omit<PendingSuggestion, "id" | "createdAt">): string {
  const id = nanoid();
  pendingSuggestions.set(id, {
    ...suggestion,
    id,
    createdAt: Date.now(),
  });
  return id;
}

export function getSuggestion(id: string): PendingSuggestion | undefined {
  const suggestion = pendingSuggestions.get(id);
  if (!suggestion) return undefined;

  // Check TTL
  if (Date.now() - suggestion.createdAt > TTL_MS) {
    pendingSuggestions.delete(id);
    return undefined;
  }

  return suggestion;
}

export function deleteSuggestion(id: string): void {
  pendingSuggestions.delete(id);
}

/** Callback handler for "Create task" button — starts the interactive flow */
export async function handleTaskCreateCallback(ctx: Context) {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    await ctx.answerCallbackQuery({ text: "Invalid action." });
    return;
  }

  const suggestionId = data.replace("task:create:", "");
  const suggestion = getSuggestion(suggestionId);

  if (!suggestion) {
    await ctx.answerCallbackQuery({ text: "This suggestion has expired." });
    await ctx.editMessageText("_Suggestion expired._", { parse_mode: "Markdown" });
    return;
  }

  try {
    const result = await startNewTaskFlow({
      title: suggestion.title,
      chatId: suggestion.chatId,
      workspacePublicId: suggestion.workspacePublicId,
      mentionsProvided: suggestion.memberPublicIds.length > 0,
      resolvedMembers: suggestion.memberPublicIds.map((id, i) => ({
        memberPublicId: id,
        displayName: suggestion.assigneeNames[i] ?? id,
      })),
      unresolvedMentions: [],
    });

    if (result.type === "created") {
      await ctx.editMessageText(result.text, {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true },
      });
    } else {
      await ctx.editMessageText(result.text, {
        parse_mode: "Markdown",
        reply_markup: result.keyboard,
      });
    }

    await ctx.answerCallbackQuery({ text: result.type === "created" ? "Task created!" : "Select options..." });
    deleteSuggestion(suggestionId);
  } catch (error) {
    console.error("Error creating task from suggestion:", error);
    await ctx.answerCallbackQuery({ text: "Error creating task." });
  }
}

/** Callback handler for "Dismiss" button */
export async function handleTaskDismissCallback(ctx: Context) {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    await ctx.answerCallbackQuery({ text: "Invalid action." });
    return;
  }

  const suggestionId = data.replace("task:dismiss:", "");
  deleteSuggestion(suggestionId);

  await ctx.editMessageText("_Suggestion dismissed._", { parse_mode: "Markdown" });
  await ctx.answerCallbackQuery({ text: "Dismissed." });
}

// Clean expired suggestions periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, suggestion] of pendingSuggestions.entries()) {
    if (now - suggestion.createdAt > TTL_MS) {
      pendingSuggestions.delete(id);
    }
  }
}, 15 * 60 * 1000); // Clean every 15 minutes
