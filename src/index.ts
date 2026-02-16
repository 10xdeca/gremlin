import "dotenv/config";
import https from "https";
import { Bot } from "grammy";

// Initialize database
import "./db/client.js";

// Import commands
import { startCommand, unlinkCommand, setTopicCommand } from "./bot/commands/start.js";
import { linkCommand, unlinkMeCommand } from "./bot/commands/link.js";
import { mapCommand } from "./bot/commands/map.js";
import { myTasksCommand } from "./bot/commands/mytasks.js";
import { overdueCommand } from "./bot/commands/overdue.js";
import { doneCommand } from "./bot/commands/done.js";
import { commentCommand } from "./bot/commands/comment.js";
import { helpCommand } from "./bot/commands/help.js";
import { namingCeremonyCommand, concludeCeremonyCommand } from "./bot/commands/namingceremony.js";

// Import scheduler
import { startTaskChecker } from "./scheduler/task-checker.js";

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

// Register commands
bot.command("start", startCommand);
bot.command("unlink", unlinkCommand);
bot.command("settopic", setTopicCommand);
bot.command("link", linkCommand);
bot.command("unlinkme", unlinkMeCommand);
bot.command("map", mapCommand);
bot.command("mytasks", myTasksCommand);
bot.command("overdue", overdueCommand);
bot.command("done", doneCommand);
bot.command("comment", commentCommand);
bot.command("help", helpCommand);
bot.command("namingceremony", namingCeremonyCommand);
bot.command("concludeceremony", concludeCeremonyCommand);

// Handle errors
bot.catch((err) => {
  console.error("Bot error:", err);
});

// Start the bot
async function main() {
  console.log("Starting Kan Bot...");

  // Verify the token works
  const botInfo = await bot.api.getMe();
  console.log(`Bot verified: @${botInfo.username}`);

  // Set bot commands for the menu
  await bot.api.setMyCommands([
    { command: "start", description: "Link chat to a Kan workspace" },
    { command: "settopic", description: "Set reminders to post in this topic" },
    { command: "link", description: "Link your Kan account (use in DM)" },
    { command: "mytasks", description: "View your assigned tasks" },
    { command: "overdue", description: "View all overdue tasks" },
    { command: "done", description: "Mark a task as complete" },
    { command: "comment", description: "Add a comment to a task" },
    { command: "help", description: "Show available commands" },
    { command: "namingceremony", description: "Start a bot naming ceremony (admin)" },
    { command: "concludeceremony", description: "End the naming ceremony early (admin)" },
  ]);
  console.log("Commands registered");

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
process.on("SIGINT", () => {
  console.log("Shutting down...");
  bot.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Shutting down...");
  bot.stop();
  process.exit(0);
});
