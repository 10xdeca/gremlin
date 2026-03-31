import http from "http";
import { mcpManager } from "./agent/mcp-manager.js";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || "8080", 10);

/** Reads version from package.json at startup. */
function loadVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "../package.json"), "utf-8"),
    );
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

const version = loadVersion();

/** Tracks whether the Telegram bot is active (polling or webhook). */
let botActive = false;
let lastMessageAt = 0;

/** Called from index.ts once the bot starts receiving updates. */
export function markBotReady(): void {
  botActive = true;
}

/** Called from index.ts on each successfully processed message. */
export function recordMessageProcessed(): void {
  lastMessageAt = Date.now();
}

/**
 * Optional webhook request handler. When set, POST requests to /webhook
 * are forwarded to this handler (grammY's webhookCallback).
 */
let webhookHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | null = null;

/** Register (or clear) a webhook handler to be served on /webhook. */
export function setWebhookHandler(handler: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | null): void {
  webhookHandler = handler;
}

/** Build the health check response. */
async function getHealthStatus(): Promise<{
  status: "healthy" | "degraded" | "unhealthy";
  components: Record<string, unknown>;
}> {
  const components: Record<string, unknown> = {};

  // Bot status
  components.bot = {
    status: botActive ? "up" : "down",
    mode: webhookHandler ? "webhook" : "polling",
    lastMessageAt: lastMessageAt || null,
  };

  // MCP servers
  const mcpHealth = await mcpManager.healthCheck();
  const allHealthy = mcpHealth.every((s) => s.status === "healthy");
  const anyHealthy = mcpHealth.some((s) => s.status === "healthy");
  components.mcp = {
    status: allHealthy ? "up" : anyHealthy ? "degraded" : "down",
    servers: mcpHealth,
  };

  // Auth — Claude Code provider uses CLI auth (claude login)
  components.auth = {
    status: "up",
    mode: "claude-code-cli",
  };

  // Overall status
  let status: "healthy" | "degraded" | "unhealthy" = "healthy";
  if (!botActive) {
    status = "unhealthy";
  } else if (!allHealthy) {
    status = "degraded";
  }

  return { status, components };
}

/** Start the health check HTTP server. Also serves the webhook endpoint when configured. */
export function startHealthServer(): void {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      try {
        const health = await getHealthStatus();
        const statusCode = health.status === "unhealthy" ? 503 : 200;
        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify(health));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", error: String(err) }));
      }
      return;
    }

    if (req.url === "/version") {
      const sha = process.env.DEPLOY_SHA || "dev";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version, sha }));
      return;
    }

    // Webhook endpoint — delegates to grammY's webhookCallback
    if (req.url === "/webhook" && req.method === "POST" && webhookHandler) {
      webhookHandler(req, res);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(HEALTH_PORT, () => {
    console.log(`Health server listening on port ${HEALTH_PORT}`);
  });
}
