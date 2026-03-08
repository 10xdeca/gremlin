import "dotenv/config";
import https from "https";
import { Bot } from "grammy";

// Initialize database
import "./db/client.js";

// Agent infrastructure
import { mcpManager } from "./agent/mcp-manager.js";
import { runAgentLoop, type ImageAttachment } from "./agent/agent-loop.js";
import { getWorkspaceLink, getAllWorkspaceLinks } from "./db/queries.js";

// Custom tool registration
import { registerChatConfigTools } from "./tools/chat-config.js";
import { registerUserMappingTools } from "./tools/user-mapping.js";
import { registerSprintInfoTools } from "./tools/sprint-info.js";
import { registerBotIdentityTools } from "./tools/bot-identity.js";
import { registerStandupTools } from "./tools/standup.js";
import { registerDeployInfoTools } from "./tools/deploy-info.js";
import { registerServerOpsTools } from "./tools/server-ops.js";

// Scheduler
import { startTaskChecker } from "./scheduler/task-checker.js";
import { startStandupChecker } from "./scheduler/standup-checker.js";
import { startCalendarChecker } from "./scheduler/calendar-checker.js";
import { startTokenHealthChecker } from "./scheduler/token-health.js";

// Admin check
const ADMIN_USER_IDS: Set<number> = new Set(
  (process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !isNaN(id))
);

function isAdmin(userId: number | undefined): boolean {
  if (!userId) return false;
  return ADMIN_USER_IDS.has(userId);
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN environment variable is required");
  process.exit(1);
}

// Force IPv4 to avoid IPv6 connectivity issues on some networks
const agent = new https.Agent({ family: 4 });

const bot = new Bot(token, {
  client: {
    baseFetchConfig: {
      agent,
    },
  },
});

// --- Rate limiting for group chats ---

const MIN_MESSAGE_LENGTH = 4;
const GROUP_COOLDOWN_MS = 30_000; // 30s cooldown per chat for non-targeted messages
const lastAgentCall = new Map<number, number>();

let botUsername: string | undefined;

// Topic cache shared with tools so they can invalidate on config changes
import { topicCache } from "./utils/topic-cache.js";
const TOPIC_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Topic types for behavioral routing. */
export type TopicType = "pm" | "social" | undefined;

async function getTopicConfig(chatId: number): Promise<{ pmThreadId: number | null; socialThreadId: number | null }> {
  const cached = topicCache.get(chatId);
  if (cached && Date.now() < cached.expiresAt) return cached;

  const link = await getWorkspaceLink(chatId);
  const entry = {
    pmThreadId: link?.messageThreadId ?? null,
    socialThreadId: link?.socialThreadId ?? null,
    expiresAt: Date.now() + TOPIC_CACHE_TTL_MS,
  };
  topicCache.set(chatId, entry);
  return entry;
}

/** Determine which topic type a message is in. */
function resolveTopicType(messageThreadId: number | undefined, pmThreadId: number | null, socialThreadId: number | null): TopicType {
  if (!messageThreadId) return undefined;
  if (pmThreadId && messageThreadId === pmThreadId) return "pm";
  if (socialThreadId && messageThreadId === socialThreadId) return "social";
  return undefined;
}

/**
 * Decide whether to skip a message to avoid unnecessary LLM calls.
 * In DMs, all messages are processed. In groups, messages must be:
 * - @mentioning the bot, OR
 * - replying to the bot, OR
 * - long enough AND outside the per-chat cooldown window
 */
function shouldSkipMessage(
  text: string,
  chatId: number,
  chatType: string,
  replyToBotId?: number,
  botId?: number
): boolean {
  // Always process DMs
  if (chatType === "private") return false;

  // Always process @mentions of the bot
  if (botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) return false;

  // Always process replies to the bot
  if (botId && replyToBotId === botId) return false;

  // Skip very short messages in groups ("ok", "lol", "k", etc.)
  if (text.trim().length < MIN_MESSAGE_LENGTH) return true;

  // Apply per-chat cooldown for non-targeted group messages
  const now = Date.now();
  const lastCall = lastAgentCall.get(chatId);
  if (lastCall && now - lastCall < GROUP_COOLDOWN_MS) return true;

  return false;
}

// --- Agent message handler (ALL messages go through the agent) ---

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  const text = ctx.message?.text;
  if (!chatId || !userId || !text) return;

  // Rate limit in group chats
  if (shouldSkipMessage(
    text,
    chatId,
    ctx.chat.type,
    ctx.message?.reply_to_message?.from?.id,
    ctx.me?.id
  )) return;

  // In groups with configured topics:
  // - In PM or Social topics: process normally (all messages subject to cooldown)
  // - In other topics: only process @mentions and replies to the bot
  let topicType: TopicType;
  if (ctx.chat.type !== "private") {
    const { pmThreadId, socialThreadId } = await getTopicConfig(chatId);
    topicType = resolveTopicType(ctx.message?.message_thread_id, pmThreadId, socialThreadId);
    const hasConfiguredTopics = pmThreadId || socialThreadId;
    if (hasConfiguredTopics && !topicType) {
      // Message is in an unrecognised topic — only respond to @mentions/replies
      const isMentioned = botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
      const isReplyToBot = ctx.me?.id && ctx.message?.reply_to_message?.from?.id === ctx.me.id;
      if (!isMentioned && !isReplyToBot) return;
    }
  }

  // Track last agent call for cooldown
  if (ctx.chat.type !== "private") {
    lastAgentCall.set(chatId, Date.now());
  }

  try {
    const response = await runAgentLoop(ctx.api, {
      text,
      chatId,
      userId,
      username: ctx.from?.username,
      isAdmin: isAdmin(userId),
      messageThreadId: ctx.message?.message_thread_id,
      topicType,
      replyToText: ctx.message?.reply_to_message?.text,
      replyToUsername: ctx.message?.reply_to_message?.from?.username,
    });

    if (response) {
      const replyOpts = {
        link_preview_options: { is_disabled: true } as const,
        ...(ctx.message?.message_thread_id
          ? { message_thread_id: ctx.message.message_thread_id }
          : {}),
      };
      try {
        await ctx.reply(response, { parse_mode: "Markdown", ...replyOpts });
      } catch (markdownError: unknown) {
        // If Telegram can't parse the Markdown, fall back to plain text
        const isParseError =
          markdownError instanceof Error &&
          markdownError.message.includes("can't parse entities");
        if (isParseError) {
          console.warn("Markdown parse failed, falling back to plain text");
          await ctx.reply(response, replyOpts);
        } else {
          throw markdownError;
        }
      }
    }
  } catch (error) {
    console.error("Agent loop error:", error);
    await ctx.reply("Something went wrong processing your message. Please try again.");
  }
});

// --- Image message handling (vision) ---

const TELEGRAM_FILE_URL = `https://api.telegram.org/file/bot${token}`;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB — matches Claude's image size limit

/** Map Telegram MIME types to Claude-supported image media types. */
function toImageMediaType(mime?: string): ImageAttachment["mediaType"] | null {
  const map: Record<string, ImageAttachment["mediaType"]> = {
    "image/jpeg": "image/jpeg",
    "image/png": "image/png",
    "image/gif": "image/gif",
    "image/webp": "image/webp",
  };
  return (mime ? map[mime] : undefined) ?? null;
}

/** Download a Telegram file as a base64 string. */
async function downloadTelegramFile(fileId: string): Promise<{ base64: string; mediaType: ImageAttachment["mediaType"] }> {
  const file = await bot.api.getFile(fileId);
  const url = `${TELEGRAM_FILE_URL}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  // Infer media type from file extension
  const ext = file.file_path?.split(".").pop()?.toLowerCase();
  const mediaType: ImageAttachment["mediaType"] =
    ext === "png" ? "image/png"
    : ext === "gif" ? "image/gif"
    : ext === "webp" ? "image/webp"
    : "image/jpeg";

  return { base64: buffer.toString("base64"), mediaType };
}

/**
 * Shared image message handler for both photos and documents.
 * Uses custom group filtering that skips the MIN_MESSAGE_LENGTH check —
 * for images, the image itself is the content regardless of caption length.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleImageMessage(
  ctx: any,
  fileId: string,
  fileSize: number | undefined,
  mediaType: ImageAttachment["mediaType"],
): Promise<void> {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const caption = (ctx.message.caption as string) ?? "";
  const messageThreadId = ctx.message.message_thread_id as number | undefined;
  const replyMsg = ctx.message.reply_to_message as { text?: string; from?: { id: number; username?: string } } | undefined;

  // Group filtering — skip MIN_MESSAGE_LENGTH check since the image is the content
  let topicType: TopicType;
  if (ctx.chat.type !== "private") {
    const isMentioned = botUsername && caption.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
    const isReplyToBot = ctx.me?.id && replyMsg?.from?.id === ctx.me.id;

    // Topic filtering
    const { pmThreadId, socialThreadId } = await getTopicConfig(chatId);
    topicType = resolveTopicType(messageThreadId, pmThreadId, socialThreadId);
    const hasConfiguredTopics = pmThreadId || socialThreadId;
    if (hasConfiguredTopics && !topicType) {
      if (!isMentioned && !isReplyToBot) return;
    }

    // Cooldown for non-targeted messages
    if (!isMentioned && !isReplyToBot) {
      const now = Date.now();
      const lastCall = lastAgentCall.get(chatId);
      if (lastCall && now - lastCall < GROUP_COOLDOWN_MS) return;
    }

    lastAgentCall.set(chatId, Date.now());
  }

  // File size guard — Claude supports images up to 5MB
  if (fileSize && fileSize > MAX_IMAGE_SIZE) {
    const replyOpts = messageThreadId ? { message_thread_id: messageThreadId } : {};
    await ctx.reply("That image is too large for me to process (max 5MB). Try sending a compressed version.", replyOpts);
    return;
  }

  const { base64, mediaType: inferredType } = await downloadTelegramFile(fileId);

  const response = await runAgentLoop(ctx.api, {
    text: caption || "What do you see in this image?",
    chatId,
    userId,
    username: ctx.from.username,
    isAdmin: isAdmin(userId),
    messageThreadId,
    topicType,
    replyToText: replyMsg?.text,
    replyToUsername: replyMsg?.from?.username,
    images: [{ base64, mediaType: mediaType ?? inferredType }],
  });

  if (response) {
    const replyOpts = {
      link_preview_options: { is_disabled: true } as const,
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    };
    try {
      await ctx.reply(response, { parse_mode: "Markdown", ...replyOpts });
    } catch (markdownError: unknown) {
      const isParseError =
        markdownError instanceof Error &&
        markdownError.message.includes("can't parse entities");
      if (isParseError) {
        console.warn("Markdown parse failed, falling back to plain text");
        await ctx.reply(response, replyOpts);
      } else {
        throw markdownError;
      }
    }
  }
}

bot.on("message:photo", async (ctx) => {
  if (!ctx.chat?.id || !ctx.from?.id) return;

  const photos = ctx.message.photo;
  const largest = photos[photos.length - 1];

  try {
    await handleImageMessage(
      ctx as never,
      largest.file_id,
      largest.file_size,
      "image/jpeg", // Telegram always compresses photos to JPEG
    );
  } catch (error) {
    console.error("Photo processing error:", error);
    await ctx.reply("Something went wrong processing your image. Please try again.");
  }
});

bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  if (!ctx.chat?.id || !ctx.from?.id || !doc) return;

  const mediaType = toImageMediaType(doc.mime_type);
  if (!mediaType) return;

  try {
    await handleImageMessage(
      ctx as never,
      doc.file_id,
      doc.file_size,
      mediaType,
    );
  } catch (error) {
    console.error("Document image processing error:", error);
    await ctx.reply("Something went wrong processing your image. Please try again.");
  }
});

// Handle errors
bot.catch((err) => {
  console.error("Bot error:", err);
});

// --- Startup ---

async function main() {
  console.log("Starting xdeca-pm-bot (agent mode)...");

  // Register custom tools
  registerChatConfigTools();
  registerUserMappingTools();
  registerSprintInfoTools();
  registerBotIdentityTools();
  registerStandupTools();
  registerDeployInfoTools();
  registerServerOpsTools();

  // Initialize MCP servers
  await mcpManager.init();

  // Verify the bot token and cache username for @mention detection
  const botInfo = await bot.api.getMe();
  botUsername = botInfo.username;
  console.log(`Bot verified: @${botInfo.username}`);

  // Clear old bot commands menu (all interaction is natural language now)
  await bot.api.setMyCommands([]);

  // Start the task checker (overdue, vague, stale, unassigned, no due date)
  startTaskChecker(bot);

  // Start the standup checker (daily prompts and summaries)
  startStandupChecker(bot);

  // Start the calendar checker (event reminders at 24h, 1h, 15m)
  startCalendarChecker(bot);

  // Start the token health checker (proactive auth validation every 4h)
  startTokenHealthChecker();

  // Start polling
  console.log("Starting polling...");
  bot.start();
  console.log("Bot is now running!");

  // Announce rebirth in Gremlin's Corner (fire-and-forget)
  announceRebirth().catch((err) => {
    console.error("Rebirth announcement failed:", err);
  });
}

/**
 * On startup, announce Gremlin's rebirth in every chat's social topic.
 * Uses the agent loop so Gremlin speaks in character and can call get_deploy_info.
 */
async function announceRebirth(): Promise<void> {
  const links = await getAllWorkspaceLinks();
  const socialChats = links.filter((l) => l.socialThreadId);

  if (socialChats.length === 0) {
    console.log("No social topics configured — skipping rebirth announcement.");
    return;
  }

  for (const link of socialChats) {
    try {
      const response = await runAgentLoop(bot.api, {
        text: "You have just been reborn (redeployed). Use get_deploy_info to see what changed, then announce your arrival in character. Keep it short and punchy.",
        chatId: link.telegramChatId,
        userId: 0, // system-initiated
        isAdmin: false,
        messageThreadId: link.socialThreadId!,
        topicType: "social",
      });

      if (response) {
        const replyOpts = {
          link_preview_options: { is_disabled: true } as const,
          message_thread_id: link.socialThreadId!,
        };
        try {
          await bot.api.sendMessage(link.telegramChatId, response, { parse_mode: "Markdown", ...replyOpts });
        } catch (markdownError: unknown) {
          const isParseError = markdownError instanceof Error && markdownError.message.includes("can't parse entities");
          if (isParseError) {
            await bot.api.sendMessage(link.telegramChatId, response, replyOpts);
          } else {
            throw markdownError;
          }
        }
      }
    } catch (err) {
      console.error(`Rebirth announcement failed for chat ${link.telegramChatId}:`, err);
    }
  }
}

main().catch((err) => {
  console.error("Failed to start bot:", err);
  process.exit(1);
});

// Handle graceful shutdown
async function shutdown() {
  console.log("Shutting down...");
  await mcpManager.shutdown();
  bot.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
