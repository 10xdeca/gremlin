import type { Api } from "grammy";
import type { ModelMessage } from "ai";
import { generateText, stepCountIs } from "ai";
import { getModel } from "../services/anthropic-client.js";
import { getTools } from "./tool-registry.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { getHistory, appendToHistory } from "./conversation-history.js";
import { alertAdmins } from "../services/admin-alerts.js";

const MAX_STEPS = 10;
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
  topicType?: "pm" | "gremlin-corner";
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
 * Check whether an error is an API auth failure (401).
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
 * Run the agent loop: send message to Claude via Vercel AI SDK, return final text.
 * The SDK handles the tool call loop automatically via maxSteps.
 */
export async function runAgentLoop(
  api: Api,
  input: AgentInput
): Promise<string> {
  const model = getModel();
  const tools = input.isSystemInitiated ? {} : getTools(input.chatId, api);

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
  const userMessage = buildUserMessage(input);
  const messages: ModelMessage[] = [...history, userMessage];

  // Send initial typing indicator
  sendTyping(api, input.chatId);

  try {
    const result = await generateText({
      model,
      system: systemPrompt,
      messages,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      maxOutputTokens: MAX_TOKENS,
      onStepFinish: () => {
        sendTyping(api, input.chatId);
      },
    });

    const text = result.text || "I ran into too many steps trying to complete that. Could you try a simpler request?";

    // Build turn for history: user message + response messages from the SDK
    const turnMessages: ModelMessage[] = [
      stripImagesFromMessage(userMessage),
      ...result.response.messages,
    ];
    appendToHistory(input.chatId, turnMessages, input.userId);

    return text;
  } catch (err) {
    if (isApiAuthError(err)) {
      console.error("API returned 401 during generateText:", err);
      alertAdmins(
        "token_auth",
        "API key rejected by Anthropic during a conversation."
      );
      return "I'm having trouble with my brain connection right now. The team has been notified.";
    }
    // Non-auth API error — let it propagate to the outer catch in index.ts
    throw err;
  }
}

/** Build a user message with optional image attachments. */
function buildUserMessage(input: AgentInput): ModelMessage {
  if (input.images?.length) {
    const content: Array<{ type: "text"; text: string } | { type: "image"; image: string; mediaType: string }> = [];

    // Add images first so Claude sees them before the text
    for (const img of input.images) {
      content.push({
        type: "image",
        image: img.base64,
        mediaType: img.mediaType,
      });
    }

    content.push({ type: "text", text: input.text || "(no caption)" });

    return { role: "user", content } as ModelMessage;
  }

  return { role: "user", content: input.text };
}

/**
 * Strip image parts from a user message before storing in history.
 * Replaces multimodal content with just the text portion to avoid
 * bloating the database with base64 image data.
 */
function stripImagesFromMessage(msg: ModelMessage): ModelMessage {
  if (msg.role !== "user" || typeof msg.content === "string") return msg;

  const blocks = msg.content as Array<{ type: string; text?: string }>;
  const hasImages = blocks.some((b) => b.type === "image");
  if (!hasImages) return msg;

  const textParts = blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n")
    .trim();

  return { role: "user", content: textParts || "[image]" };
}

/** Fire-and-forget typing indicator. */
function sendTyping(api: Api, chatId: number): void {
  api.sendChatAction(chatId, "typing").catch(() => {
    // Typing indicator failures are not critical
  });
}
