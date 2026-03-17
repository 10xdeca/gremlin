import type Anthropic from "@anthropic-ai/sdk";
import type { Api } from "grammy";
import { getAnthropicTools, executeTool } from "./tool-registry.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { getHistory, appendToHistory } from "./conversation-history.js";
import {
  getAnthropicClient,
  invalidateCachedClient,
} from "../services/anthropic-client.js";
import { alertAdmins } from "../services/admin-alerts.js";

// TODO: Revert to claude-sonnet-4-6 when Anthropic fixes OAuth for Sonnet/Opus models
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOOL_ROUNDS = 10;
const MAX_TOKENS = 2048;

export interface ImageAttachment {
  /** Base64-encoded image data. */
  base64: string;
  /** MIME type, e.g. "image/jpeg". */
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

interface AgentInput {
  text: string;
  chatId: number;
  userId: number;
  username?: string;
  isAdmin: boolean;
  messageThreadId?: number;
  topicType?: "pm" | "social";
  replyToText?: string;
  replyToUsername?: string;
  /** When true, the agent composes a message without tool access (used for scheduled reminders). */
  isSystemInitiated?: boolean;
  /** Optional images attached to the message (e.g. Telegram photos). */
  images?: ImageAttachment[];
  /** Override private chat detection (needed for system-initiated DMs where chatId !== userId). */
  isPrivateChat?: boolean;
}

/**
 * Check whether an error is an Anthropic API auth failure (401).
 * The SDK throws errors with a `status` property for HTTP-level failures.
 */
function isApiAuthError(err: unknown): boolean {
  return (
    err != null &&
    typeof err === "object" &&
    "status" in err &&
    (err as { status: number }).status === 401
  );
}

/**
 * Run the agent loop: send message to Claude, execute tool calls, return final text.
 * Sends typing indicators while working.
 */
export async function runAgentLoop(
  api: Api,
  input: AgentInput
): Promise<string> {
  let anthropic: Anthropic;
  try {
    anthropic = await getAnthropicClient();
  } catch (err) {
    // getAnthropicClient already logs and alerts admins
    console.error("Failed to get Anthropic client:", err);
    return "I'm having trouble with my brain connection right now. The team has been notified.";
  }

  const tools = input.isSystemInitiated ? [] : getAnthropicTools();
  // Telegram convention: in private chats, chatId === userId.
  // Allow explicit override for system-initiated DMs (userId=0).
  const isPrivateChat = input.isPrivateChat ?? input.chatId === input.userId;
  const systemPrompt = await buildSystemPrompt({
    chatId: input.chatId,
    userId: input.userId,
    username: input.username,
    isAdmin: input.isAdmin,
    messageThreadId: input.messageThreadId,
    topicType: input.topicType,
    replyToText: input.replyToText,
    replyToUsername: input.replyToUsername,
    isPrivateChat,
  });

  // Build messages: history + current user message
  const history = getHistory(input.chatId);
  const userContent: Anthropic.Messages.ContentBlockParam[] = [];

  // Add images first so Claude sees them before the text
  if (input.images?.length) {
    for (const img of input.images) {
      userContent.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.base64 },
      });
    }
  }

  userContent.push({ type: "text", text: input.text || "(no caption)" });

  const userMessage: Anthropic.Messages.MessageParam = {
    role: "user",
    content: input.images?.length ? userContent : input.text,
  };
  const messages: Anthropic.Messages.MessageParam[] = [...history, userMessage];

  // Send initial typing indicator
  sendTyping(api, input.chatId);

  let response: Anthropic.Messages.Message;
  let rounds = 0;

  // Agent loop — keep calling Claude until we get a final text response
  while (rounds < MAX_TOOL_ROUNDS) {
    rounds++;

    try {
      response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        ...(tools.length > 0 ? { tools } : {}),
        messages,
      });
    } catch (err) {
      if (isApiAuthError(err)) {
        // Access token rejected mid-session — force re-auth on next call
        console.error("Anthropic API returned 401 during messages.create:", err);
        invalidateCachedClient();
        alertAdmins(
          "token_auth",
          "Access token rejected by Anthropic API during a conversation. Client cache invalidated — next request will attempt re-auth."
        );
        return "I'm having trouble with my brain connection right now. The team has been notified.";
      }
      // Non-auth API error — let it propagate to the outer catch in index.ts
      throw err;
    }

    // Check if there are tool calls
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) {
      // No tool calls — extract final text and return
      const text = extractText(response.content);
      // Capture the full turn: everything added since history ended
      const turnMessages = stripImagesFromTurn(messages.slice(history.length));
      turnMessages.push({ role: "assistant", content: text });
      appendToHistory(input.chatId, turnMessages, input.userId);
      return text;
    }

    // There are tool calls — execute them and continue the loop
    // Add assistant response (with tool_use blocks) to messages
    messages.push({ role: "assistant", content: response.content });

    // Execute all tool calls
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const toolUse of toolUseBlocks) {
      // Keep typing while working
      sendTyping(api, input.chatId);

      let result: string;
      let isError = false;
      try {
        console.log(`Tool call: ${toolUse.name}(${JSON.stringify(toolUse.input)})`);
        result = await executeTool(
          toolUse.name,
          toolUse.input as Record<string, unknown>
        );
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        isError = true;
        console.error(`Tool ${toolUse.name} failed:`, err);
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result,
        is_error: isError,
      });
    }

    // Add tool results to messages
    messages.push({ role: "user", content: toolResults });
  }

  // Exhausted tool rounds — cap with text-only assistant message.
  // Don't store unfulfilled tool_use blocks from response — they'd lack matching tool_results.
  const fallbackText = extractText(response!.content);
  const cappingText = fallbackText || "I ran into too many steps trying to complete that. Could you try a simpler request?";
  const turnMessages = stripImagesFromTurn(messages.slice(history.length));
  turnMessages.push({ role: "assistant", content: cappingText });
  appendToHistory(input.chatId, turnMessages, input.userId);
  return cappingText;
}

/** Extract text content from Claude response blocks. */
function extractText(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Strip image blocks from turn messages before storing in history/DB.
 * Replaces multimodal user content with just the text portion to avoid
 * bloating the database with base64 image data.
 */
function stripImagesFromTurn(
  messages: Anthropic.Messages.MessageParam[],
): Anthropic.Messages.MessageParam[] {
  return messages.map((msg) => {
    if (msg.role !== "user" || typeof msg.content === "string") return msg;

    const blocks = msg.content as Anthropic.Messages.ContentBlockParam[];
    // If content has image blocks, extract just the text
    const hasImages = blocks.some((b) => b.type === "image");
    if (!hasImages) return msg;

    const textParts = blocks
      .filter((b): b is Anthropic.Messages.TextBlockParam => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return { role: "user" as const, content: textParts || "[image]" };
  });
}

/** Fire-and-forget typing indicator. */
function sendTyping(api: Api, chatId: number): void {
  api.sendChatAction(chatId, "typing").catch(() => {
    // Typing indicator failures are not critical
  });
}
