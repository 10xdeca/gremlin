import "dotenv/config";
import https from "https";
import { Bot } from "grammy";

// Initialize database
import "./db/client.js";

// Agent infrastructure
import { mcpManager } from "./agent/mcp-manager.js";
import { runAgentLoop } from "./agent/agent-loop.js";

// Custom tool registration
import { registerChatConfigTools } from "./tools/chat-config.js";
import { registerUserMappingTools } from "./tools/user-mapping.js";
import { registerSprintInfoTools } from "./tools/sprint-info.js";
import { registerBotIdentityTools } from "./tools/bot-identity.js";

// Scheduler
import { startTaskChecker } from "./scheduler/task-checker.js";

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

// --- Agent message handler (ALL messages go through the agent) ---

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  const text = ctx.message?.text;
  if (!chatId || !userId || !text) return;

  try {
    const response = await runAgentLoop(ctx.api, {
      text,
      chatId,
      userId,
      username: ctx.from?.username,
      isAdmin: isAdmin(userId),
      messageThreadId: ctx.message?.message_thread_id,
      replyToText: ctx.message?.reply_to_message?.text,
      replyToUsername: ctx.message?.reply_to_message?.from?.username,
    });

    if (response) {
      await ctx.reply(response, {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true },
        ...(ctx.message?.message_thread_id
          ? { message_thread_id: ctx.message.message_thread_id }
          : {}),
      });
    }
  } catch (error) {
    console.error("Agent loop error:", error);
    await ctx.reply("Something went wrong processing your message. Please try again.");
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

  // Initialize MCP servers
  await mcpManager.init();

  // Verify the bot token
  const botInfo = await bot.api.getMe();
  console.log(`Bot verified: @${botInfo.username}`);

  // Clear old bot commands menu (all interaction is natural language now)
  await bot.api.setMyCommands([]);

  // Start the task checker (overdue, vague, stale, unassigned, no due date)
  startTaskChecker(bot);

  // Start polling
  console.log("Starting polling...");
  bot.start();
  console.log("Bot is now running!");
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
