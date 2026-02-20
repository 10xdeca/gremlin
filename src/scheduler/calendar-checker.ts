import cron from "node-cron";
import type { Bot } from "grammy";
import { mcpManager } from "../agent/mcp-manager.js";
import {
  getAllWorkspaceLinks,
  hasCalendarReminderBeenSent,
  recordCalendarReminder,
  cleanOldCalendarReminders,
} from "../db/queries.js";
import { handleUnreachableChat } from "../utils/telegram.js";

/** Shape returned by radicale_list_events. */
interface CalendarEvent {
  uid: string;
  summary: string;
  description: string;
  start: string | null;
  end: string | null;
  location: string;
  status: string;
  url: string;
}

/** Shape returned by radicale_list_calendars. */
interface Calendar {
  url: string;
  displayName: string;
}

type ReminderWindow = "24h" | "1h" | "15m";

/** Cached calendar URL so we don't re-discover every 15 minutes. */
let cachedCalendarUrl: string | null = null;

/**
 * Start the calendar event reminder scheduler.
 * Runs every 15 minutes, checks for upcoming events and sends reminders.
 */
export function startCalendarChecker(bot: Bot): void {
  console.log("Starting calendar checker (every 15 minutes)");

  cron.schedule("*/15 * * * *", async () => {
    console.log("Running calendar check...");
    await checkCalendarEvents(bot);
  });

  // Clean old calendar reminders daily at 3:15am (offset from task-checker's 3am)
  cron.schedule("15 3 * * *", async () => {
    console.log("Cleaning old calendar reminders...");
    await cleanOldCalendarReminders(7);
  });

  // Run once on startup after a short delay
  setTimeout(() => {
    console.log("Running initial calendar check...");
    checkCalendarEvents(bot);
  }, 10000);
}

/** Discover the calendar URL, cached after first call. */
async function getCalendarUrl(): Promise<string | null> {
  if (cachedCalendarUrl) return cachedCalendarUrl;

  try {
    const result = await mcpManager.callTool("radicale_list_calendars", {});
    const calendars: Calendar[] = JSON.parse(result);
    if (calendars.length === 0) {
      console.log("Calendar checker: no calendars found");
      return null;
    }
    // Use the first calendar (the shared xdeca calendar)
    cachedCalendarUrl = calendars[0].url;
    console.log(`Calendar checker: using calendar "${calendars[0].displayName}" (${cachedCalendarUrl})`);
    return cachedCalendarUrl;
  } catch (error) {
    console.error("Calendar checker: failed to list calendars:", error);
    return null;
  }
}

/** Determine which reminder window an event falls into, if any. */
function getMatchingWindow(minutesUntil: number): ReminderWindow | null {
  if (minutesUntil <= 15 && minutesUntil > 0) return "15m";
  if (minutesUntil <= 60 && minutesUntil > 15) return "1h";
  if (minutesUntil <= 1440 && minutesUntil > 60) return "24h";
  return null;
}

/** Format a reminder message for a given window. */
function formatReminderMessage(event: CalendarEvent, window: ReminderWindow): string {
  const eventStart = new Date(event.start!);

  // Format time in AEDT (Australia/Sydney)
  const timeStr = eventStart.toLocaleTimeString("en-AU", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Australia/Sydney",
  });

  const dateStr = eventStart.toLocaleDateString("en-AU", {
    month: "short",
    day: "numeric",
    timeZone: "Australia/Sydney",
  });

  const escapedSummary = escapeMarkdown(event.summary || "Untitled event");
  const escapedTime = escapeMarkdown(timeStr);
  const escapedDate = escapeMarkdown(dateStr);

  // Check if the event is actually on a different calendar day (tomorrow)
  const tz = "Australia/Sydney";
  const todayStr = new Date().toLocaleDateString("en-AU", { timeZone: tz });
  const eventDayStr = eventStart.toLocaleDateString("en-AU", { timeZone: tz });
  const isTomorrow = todayStr !== eventDayStr;

  switch (window) {
    case "24h": {
      const label = isTomorrow ? "Tomorrow" : "Coming up";
      return `\u{1F4C5} *${label}:* ${escapedSummary} \u2014 ${escapedDate} at ${escapedTime} AEDT`;
    }
    case "1h":
      return `\u{23F0} *In 1 hour:* ${escapedSummary} \u2014 ${escapedTime} AEDT`;
    case "15m":
      return `\u{1F514} *Starting soon:* ${escapedSummary} \u2014 ${escapedTime} AEDT`;
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*\[\]()~`>#+=|{}.!-]/g, "\\$&");
}

async function checkCalendarEvents(bot: Bot): Promise<void> {
  try {
    const calendarUrl = await getCalendarUrl();
    if (!calendarUrl) return;

    const workspaceLinks = await getAllWorkspaceLinks();
    if (workspaceLinks.length === 0) {
      console.log("Calendar checker: no workspace links configured, skipping");
      return;
    }

    // Fetch events for the next 24 hours
    const now = new Date();
    const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const result = await mcpManager.callTool("radicale_list_events", {
      calendar_url: calendarUrl,
      start: now.toISOString(),
      end: end.toISOString(),
    });

    const events: CalendarEvent[] = JSON.parse(result);
    if (events.length === 0) return;

    for (const event of events) {
      if (!event.start || !event.uid) continue;

      const eventStart = new Date(event.start);
      const minutesUntil = (eventStart.getTime() - now.getTime()) / (1000 * 60);
      const window = getMatchingWindow(minutesUntil);
      if (!window) continue;

      const message = formatReminderMessage(event, window);

      for (const link of workspaceLinks) {
        const alreadySent = await hasCalendarReminderBeenSent(
          event.uid,
          link.telegramChatId,
          window,
        );
        if (alreadySent) continue;

        try {
          await bot.api.sendMessage(link.telegramChatId, message, {
            parse_mode: "MarkdownV2",
            link_preview_options: { is_disabled: true },
            ...(link.messageThreadId ? { message_thread_id: link.messageThreadId } : {}),
          });

          await recordCalendarReminder(event.uid, link.telegramChatId, window);
          console.log(`Sent ${window} reminder for "${event.summary}" to chat ${link.telegramChatId}`);
        } catch (error) {
          if (await handleUnreachableChat(error, link.telegramChatId)) continue;
          console.error(`Failed to send calendar reminder to chat ${link.telegramChatId}:`, error);
        }
      }
    }
  } catch (error) {
    console.error("Error in calendar checker:", error);
  }
}
