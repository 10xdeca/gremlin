import type Anthropic from "@anthropic-ai/sdk";
import type { Api } from "grammy";
import { getAnthropicTools, executeTool } from "./tool-registry.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { getHistory, appendToHistory } from "./conversation-history.js";
import { getAnthropicClient } from "../services/anthropic-client.js";

const MODEL = "claude-sonnet-4-5-20250929";
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
}

/**
 * Run the agent loop: send message to Claude, execute tool calls, return final text.
 * Sends typing indicators while working.
 */
export async function runAgentLoop(
  api: Api,
  input: AgentInput
): Promise<string> {
  const anthropic = await getAnthropicClient();
  const tools = getAnthropicTools();
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

    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      tools,
      messages,
    });

    // Check if there are tool calls
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) {
      // No tool calls — extract final text and return
      const text = extractText(response.content);
      const assistantMessage: Anthropic.Messages.MessageParam = {
        role: "assistant",
        content: text,
      };
      appendToHistory(input.chatId, userMessage, assistantMessage);
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

  // Exhausted tool rounds — return whatever text we have
  const fallbackText = extractText(response!.content);
  const assistantMessage: Anthropic.Messages.MessageParam = {
    role: "assistant",
    content: fallbackText || "I ran into too many steps trying to complete that. Could you try a simpler request?",
  };
  appendToHistory(input.chatId, userMessage, assistantMessage);
  return assistantMessage.content as string;
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
