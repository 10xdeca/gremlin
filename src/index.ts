import "dotenv/config";
import https from "https";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import { Bot, webhookCallback } from "grammy";

// Log unhandled rejections before crashing so we get diagnostics in logs.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection (will crash):", err);
});

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
import { registerDirectMessageTools } from "./tools/direct-message.js";
import { registerGitHubRepoTools } from "./tools/github-repo.js";
import { registerResearchTool } from "./tools/research.js";
import { registerKickstartTools } from "./tools/kickstart.js";

// Scheduler
import { startTaskChecker } from "./scheduler/task-checker.js";
import { startStandupChecker } from "./scheduler/standup-checker.js";
import { startCalendarChecker } from "./scheduler/calendar-checker.js";
// Health check server
import { startHealthServer, setWebhookHandler, markBotReady, recordMessageProcessed } from "./health.js";

// Contact scanner
import { scanImageForContacts, type ScanContext } from "./scanner/contact-scanner.js";

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

  // Never respond to own messages
  if (ctx.from?.is_bot && userId === ctx.me?.id) return;

  // Rate limit in group chats
  if (shouldSkipMessage(
    text,
    chatId,
    ctx.chat.type,
    ctx.message?.reply_to_message?.from?.id,
    ctx.me?.id
  )) return;

  // In groups with configured topics:
  // - In PM topic: process normally (all messages subject to cooldown)
  // - In Social or other topics: only process @mentions and replies to the bot
  let topicType: TopicType;
  if (ctx.chat.type !== "private") {
    const { pmThreadId, socialThreadId } = await getTopicConfig(chatId);
    topicType = resolveTopicType(ctx.message?.message_thread_id, pmThreadId, socialThreadId);
    const hasConfiguredTopics = pmThreadId || socialThreadId;
    if (hasConfiguredTopics && topicType !== "pm") {
      // Message is in social or unrecognised topic — only respond to @mentions/replies
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
    // If replying to a message with a photo/image document, download and attach it
    // so Claude can see the image (e.g. "scan this", "what does this show?")
    let replyImages: ImageAttachment[] | undefined;
    const replyMsg = ctx.message?.reply_to_message;
    if (replyMsg) {
      try {
        if (replyMsg.photo?.length) {
          const largest = replyMsg.photo[replyMsg.photo.length - 1];
          if (!largest.file_size || largest.file_size <= MAX_IMAGE_SIZE) {
            const { base64, mediaType } = await downloadTelegramFile(largest.file_id);
            replyImages = [{ base64, mediaType }];
          }
        } else if (replyMsg.document) {
          const docType = toImageMediaType(replyMsg.document.mime_type);
          if (docType && (!replyMsg.document.file_size || replyMsg.document.file_size <= MAX_IMAGE_SIZE)) {
            const { base64, mediaType } = await downloadTelegramFile(replyMsg.document.file_id);
            replyImages = [{ base64, mediaType }];
          }
        }
      } catch (err) {
        console.warn("Failed to download replied-to image:", err);
      }
    }

    const response = await runAgentLoop(ctx.api, {
      text,
      chatId,
      userId,
      username: ctx.from?.username,
      isAdmin: isAdmin(userId),
      messageThreadId: ctx.message?.message_thread_id,
      topicType,
      replyToText: ctx.message?.reply_to_message?.text ?? ctx.message?.reply_to_message?.caption,
      replyToUsername: ctx.message?.reply_to_message?.from?.username,
      images: replyImages,
    });

    if (response) {
      recordMessageProcessed();
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
    const errorReplyOpts = ctx.message?.message_thread_id
      ? { message_thread_id: ctx.message.message_thread_id }
      : {};
    await ctx.reply("Something went wrong processing your message. Please try again.", errorReplyOpts);
  }
});

// --- New member onboarding via DM ---

bot.on("message:new_chat_members", async (ctx) => {
  const chatId = ctx.chat.id;
  const members = ctx.message.new_chat_members;

  for (const member of members) {
    // Skip bot self-joins
    if (member.id === ctx.me.id) continue;

    // Sanitize display name — first_name is user-controlled and could contain prompt injection attempts.
    // Blocklist approach: strip control chars and Markdown-special chars, but keep Unicode letters/emoji.
    const safeName = (member.username ? `@${member.username}` : member.first_name).slice(0, 64).replace(/[\x00-\x1f*_`\[\]()~>#+\-=|{}!\\]/g, "")
    const displayName = safeName || "new member";
    console.log(`New member joined chat ${chatId}: ${displayName} (${member.id})`);

    try {
      // Run agent loop to generate a welcome/onboarding message
      const response = await runAgentLoop(bot.api, {
        text: `A new member just joined the group: ${displayName} (Telegram ID: ${member.id}). Welcome them warmly, introduce yourself, and start learning about them — timezone, role, interests, etc. Be conversational, not interrogative.`,
        chatId: member.id,
        userId: 0, // system-initiated
        isAdmin: false,
        isPrivateChat: true,
      });

      if (response) {
        try {
          // Try sending as a DM
          await bot.api.sendMessage(member.id, response, {
            parse_mode: "Markdown",
            link_preview_options: { is_disabled: true },
          });
          console.log(`Onboarding DM sent to ${displayName}`);
        } catch (dmError: unknown) {
          // DM failed (likely 403 — user hasn't started the bot yet)
          // Fall back to a group welcome in the social topic
          console.warn(`DM to ${displayName} failed, falling back to group welcome:`, dmError);

          const { socialThreadId } = await getTopicConfig(chatId);
          const replyOpts = {
            link_preview_options: { is_disabled: true } as const,
            ...(socialThreadId ? { message_thread_id: socialThreadId } : {}),
          };
          const groupWelcome = `Welcome ${displayName}! 👋 Send me a DM to get started — I'd love to learn about you and get you set up.`;
          try {
            await bot.api.sendMessage(chatId, groupWelcome, { parse_mode: "Markdown", ...replyOpts });
          } catch (markdownError: unknown) {
            const isParseError = markdownError instanceof Error && markdownError.message.includes("can't parse entities");
            if (isParseError) {
              await bot.api.sendMessage(chatId, groupWelcome, replyOpts);
            }
          }
        }
      }
    } catch (error) {
      console.error(`Onboarding error for ${displayName}:`, error);
    }
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

    // Topic filtering — only PM topic gets proactive responses
    const { pmThreadId, socialThreadId } = await getTopicConfig(chatId);
    topicType = resolveTopicType(messageThreadId, pmThreadId, socialThreadId);
    const hasConfiguredTopics = pmThreadId || socialThreadId;
    if (hasConfiguredTopics && topicType !== "pm") {
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
    recordMessageProcessed();
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

// --- Background contact scanner middleware ---
// Fires before normal photo/document handlers. Downloads the image and scans
// for contact information in the background (fire-and-forget), then calls next()
// so normal handlers run unaffected.

if (process.env.CONTACT_SCANNER_ENABLED === "true") {
  bot.on(["message:photo", "message:document"], async (ctx, next) => {
    // Skip DMs — private chats already have natural contact creation via onboarding
    if (ctx.chat.type === "private") return next();

    try {
      let fileId: string | undefined;
      let fileSize: number | undefined;
      let mediaType: ImageAttachment["mediaType"] | null = null;

      if (ctx.message.photo) {
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1];
        fileId = largest.file_id;
        fileSize = largest.file_size;
        mediaType = "image/jpeg";
      } else if (ctx.message.document) {
        const doc = ctx.message.document;
        mediaType = toImageMediaType(doc.mime_type);
        if (mediaType) {
          fileId = doc.file_id;
          fileSize = doc.file_size;
        }
      }

      if (fileId && mediaType && (!fileSize || fileSize <= MAX_IMAGE_SIZE)) {
        const scanCtx: ScanContext = {
          chatId: ctx.chat.id,
          messageThreadId: ctx.message.message_thread_id,
        };

        // Confirmation callback — sends the confirmation message to the same thread
        const sendConfirmation = async (sCtx: ScanContext, message: string) => {
          const opts = {
            link_preview_options: { is_disabled: true } as const,
            ...(sCtx.messageThreadId ? { message_thread_id: sCtx.messageThreadId } : {}),
          };
          try {
            await bot.api.sendMessage(sCtx.chatId, message, { parse_mode: "Markdown", ...opts });
          } catch (markdownError: unknown) {
            const isParseError = markdownError instanceof Error && markdownError.message.includes("can't parse entities");
            if (isParseError) {
              await bot.api.sendMessage(sCtx.chatId, message, opts);
            } else {
              throw markdownError;
            }
          }
        };

        // Fire-and-forget — download and scan in background
        downloadTelegramFile(fileId)
          .then(({ base64, mediaType: inferredType }) =>
            scanImageForContacts(base64, mediaType ?? inferredType, scanCtx, sendConfirmation),
          )
          .catch((err) => {
            console.error("Contact scanner: download/scan failed:", err);
          });
      }
    } catch (err) {
      console.error("Contact scanner middleware error:", err);
    }

    return next();
  });
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
    const errorReplyOpts = ctx.message?.message_thread_id
      ? { message_thread_id: ctx.message.message_thread_id }
      : {};
    await ctx.reply("Something went wrong processing your image. Please try again.", errorReplyOpts);
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
    const errorReplyOpts = ctx.message?.message_thread_id
      ? { message_thread_id: ctx.message.message_thread_id }
      : {};
    await ctx.reply("Something went wrong processing your image. Please try again.", errorReplyOpts);
  }
});

// Handle errors
bot.catch((err) => {
  console.error("Bot error:", err);
});

// --- Startup ---

async function main() {
  console.log("Starting Gremlin (agent mode)...");

  // Register custom tools
  registerChatConfigTools();
  registerUserMappingTools();
  registerSprintInfoTools();
  registerBotIdentityTools();
  registerStandupTools();
  registerDeployInfoTools();
  registerServerOpsTools();
  registerDirectMessageTools(bot.api);
  registerGitHubRepoTools();
  registerResearchTool(bot.api);
  registerKickstartTools();

  // Initialize MCP servers
  await mcpManager.init();

  // Verify the bot token and cache username for @mention detection
  const botInfo = await bot.api.getMe();
  botUsername = botInfo.username;
  console.log(`Bot verified: @${botInfo.username}`);

  // Clear old bot commands menu (all interaction is natural language now)
  try {
    await bot.api.setMyCommands([]);
  } catch (err) {
    console.warn("setMyCommands failed (non-fatal, likely rate-limited):", (err as Error).message);
  }

  // Start the task checker (overdue, vague, stale, unassigned, no due date)
  startTaskChecker(bot);

  // Start the standup checker (daily prompts and summaries)
  startStandupChecker(bot);

  // Start the calendar checker (event reminders at 24h, 1h, 15m)
  startCalendarChecker(bot);

  // Start health check server (also serves webhook endpoint when configured)
  startHealthServer();

  const webhookUrl = process.env.WEBHOOK_URL;

  if (webhookUrl) {
    // --- Webhook mode ---
    const webhookSecret = process.env.WEBHOOK_SECRET || crypto.randomBytes(32).toString("hex");

    console.log(`Setting webhook to ${webhookUrl}/webhook ...`);
    await bot.api.setWebhook(`${webhookUrl}/webhook`, {
      secret_token: webhookSecret,
      drop_pending_updates: true,
    });
    console.log("Webhook set successfully.");

    // Register grammY's webhook handler AFTER setWebhook succeeds.
    // webhookCallback() must be called after setWebhook, not before,
    // because it permanently marks the bot as webhook-mode (blocking bot.start()).
    const handler = webhookCallback(bot, "http", { secretToken: webhookSecret });
    setWebhookHandler(handler);

    markBotReady();
    console.log("Bot is now running in webhook mode!");
  } else {
    // --- Polling mode (local dev / no webhook configured) ---
    console.log("No WEBHOOK_URL set — using polling mode.");
    await bot.api.deleteWebhook({ drop_pending_updates: true });

    console.log("Starting polling...");
    bot.start({
      drop_pending_updates: true,
      onStart: () => {
        markBotReady();
        console.log("Bot is now running in polling mode!");
      },
    });
  }

  // Announce rebirth in Gremlin's Corner (fire-and-forget)
  announceRebirth().catch((err) => {
    console.error("Rebirth announcement failed:", err);
  });
}

/** Cooldown (in ms) to suppress repeated rebirth announcements from rapid restarts. */
const REBIRTH_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
const REBIRTH_MARKER_PATH = path.join(os.tmpdir(), "gremlin-last-rebirth");

/**
 * On startup, announce Gremlin's rebirth in every chat's social topic.
 * Uses the agent loop so Gremlin speaks in character and can call get_deploy_info.
 *
 * Skipped if a rebirth was announced within the last 10 minutes (guards against
 * restart loops flooding chats). Set SKIP_REBIRTH_ANNOUNCEMENT=true to disable entirely.
 */
async function announceRebirth(): Promise<void> {
  // Allow completely disabling rebirth announcements via env var
  if (process.env.SKIP_REBIRTH_ANNOUNCEMENT === "true") {
    console.log("SKIP_REBIRTH_ANNOUNCEMENT is set — skipping rebirth announcement.");
    return;
  }

  // Cooldown: skip if last announcement was too recent (rapid restart protection)
  try {
    const stat = fs.statSync(REBIRTH_MARKER_PATH);
    const elapsed = Date.now() - stat.mtimeMs;
    if (elapsed < REBIRTH_COOLDOWN_MS) {
      console.log(`Rebirth announced ${Math.round(elapsed / 1000)}s ago (cooldown ${REBIRTH_COOLDOWN_MS / 1000}s) — skipping.`);
      return;
    }
  } catch {
    // File doesn't exist — first run or marker cleared, proceed
  }

  // Touch the marker file before announcing (so even if we crash mid-announce, cooldown applies)
  try {
    fs.writeFileSync(REBIRTH_MARKER_PATH, String(Date.now()));
  } catch (err) {
    console.warn("Failed to write rebirth marker:", err);
  }

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
