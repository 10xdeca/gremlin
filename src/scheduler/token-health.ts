import cron from "node-cron";
import { getAnthropicClient, getTokenHealth } from "../services/anthropic-client.js";

/**
 * Periodic token health checker.
 * Runs every 4 hours to proactively verify the OAuth refresh token works.
 * If the refresh fails, getAnthropicClient() fires admin alerts automatically.
 */
export function startTokenHealthChecker(): void {
  console.log("Starting token health checker (every 4 hours)");

  cron.schedule("0 */4 * * *", async () => {
    console.log("Running token health check...");
    await checkTokenHealth();
  });

  // Run once on startup after a short delay (after MCP init)
  setTimeout(() => {
    console.log("Running initial token health check...");
    checkTokenHealth();
  }, 10_000);
}

async function checkTokenHealth(): Promise<void> {
  try {
    await getAnthropicClient();
    const health = getTokenHealth();
    const expiresIn = Math.round((health.expiresAt - Date.now()) / (1000 * 60 * 60));
    console.log(`Token health: ${health.status}, expires in ~${expiresIn}h`);
  } catch (err) {
    // getAnthropicClient already logs and alerts admins — just log the health check failure
    console.error("Token health check failed:", err instanceof Error ? err.message : err);
  }
}
