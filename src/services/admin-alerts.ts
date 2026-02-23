/**
 * Admin alert service — sends Telegram DMs directly to admin user IDs.
 * Uses raw fetch() against the Telegram Bot API (no Grammy dependency)
 * so alerts work even if the bot framework is down.
 */

const TELEGRAM_API = "https://api.telegram.org";
const RATE_LIMIT_MS = 60 * 60 * 1000; // 1 alert per type per hour

/** Tracks the last alert timestamp per alert type to prevent spam. */
const lastAlertAt = new Map<string, number>();

/** Cached admin user IDs — parsed from env on first use. */
let cachedAdminIds: number[] | null = null;

/** Parse admin user IDs from env, caching the result. */
function getAdminUserIds(): number[] {
  if (cachedAdminIds) return cachedAdminIds;
  cachedAdminIds = (process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !isNaN(id));
  return cachedAdminIds;
}

/**
 * Send an alert message to all admin users via Telegram DM.
 * Rate-limited: at most 1 alert per `alertType` per hour.
 * Fire-and-forget — logs to console.error if Telegram send fails.
 */
export async function alertAdmins(
  alertType: string,
  message: string
): Promise<void> {
  // Rate limit check
  const now = Date.now();
  const lastSent = lastAlertAt.get(alertType);
  if (lastSent && now - lastSent < RATE_LIMIT_MS) {
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error(`[admin-alert] No TELEGRAM_BOT_TOKEN, cannot send alert: ${message}`);
    return;
  }

  const adminIds = getAdminUserIds();
  if (adminIds.length === 0) {
    console.error(`[admin-alert] No ADMIN_USER_IDS configured, cannot send alert: ${message}`);
    return;
  }

  // Mark as sent before attempting (prevents retry storms on slow networks)
  lastAlertAt.set(alertType, now);

  const fullMessage = `⚠️ *Bot Alert* (${alertType})\n\n${message}`;

  for (const chatId of adminIds) {
    try {
      const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: fullMessage,
          parse_mode: "Markdown",
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        console.error(`[admin-alert] Failed to DM admin ${chatId}: ${res.status} ${body}`);
      }
    } catch (err) {
      console.error(`[admin-alert] Failed to DM admin ${chatId}:`, err);
    }
  }
}
