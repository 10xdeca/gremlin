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

const MODEL = "claude-sonnet-4-6";
const MAX_TOOL_ROUNDS = 10;
const MAX_TOKENS = 2048;

interface AgentInput {
  text: string;
  chatId: number;
  userId: number;
  username?: string;
  isAdmin: boolean;
  messageThreadId?: number;
  replyToText?: string;
  replyToUsername?: string;
  /** When true, the agent composes a message without tool access (used for scheduled reminders). */
  isSystemInitiated?: boolean;
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
  const systemPrompt = await buildSystemPrompt({
    chatId: input.chatId,
    userId: input.userId,
    username: input.username,
    isAdmin: input.isAdmin,
    messageThreadId: input.messageThreadId,
    replyToText: input.replyToText,
    replyToUsername: input.replyToUsername,
  });

  // Build messages: history + current user message
  const history = getHistory(input.chatId);
  const userMessage: Anthropic.Messages.MessageParam = {
    role: "user",
    content: input.text,
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
      const turnMessages = messages.slice(history.length);
      turnMessages.push({ role: "assistant", content: text });
      appendToHistory(input.chatId, turnMessages);
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
  const turnMessages = messages.slice(history.length);
  turnMessages.push({ role: "assistant", content: cappingText });
  appendToHistory(input.chatId, turnMessages);
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

/** Fire-and-forget typing indicator. */
function sendTyping(api: Api, chatId: number): void {
  api.sendChatAction(chatId, "typing").catch(() => {
    // Typing indicator failures are not critical
  });
}
