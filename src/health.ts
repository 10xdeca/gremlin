import http from "http";
import { mcpManager } from "./agent/mcp-manager.js";
import { getTokenHealth } from "./services/anthropic-client.js";
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

/** Tracks whether the Telegram bot polling is active. */
let botPollingActive = false;
let lastMessageAt = 0;

/** Called from index.ts once the bot starts polling. */
export function markBotReady(): void {
  botPollingActive = true;
}

/** Called from index.ts on each successfully processed message. */
export function recordMessageProcessed(): void {
  lastMessageAt = Date.now();
}

/** Build the health check response. */
async function getHealthStatus(): Promise<{
  status: "healthy" | "degraded" | "unhealthy";
  components: Record<string, unknown>;
}> {
  const components: Record<string, unknown> = {};

  // Bot polling
  components.bot = {
    status: botPollingActive ? "up" : "down",
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

  // Token/auth
  const tokenHealth = getTokenHealth();
  components.auth = {
    status: tokenHealth.status === "healthy" ? "up" : tokenHealth.status,
    expiresAt: tokenHealth.expiresAt || null,
  };

  // Overall status
  let status: "healthy" | "degraded" | "unhealthy" = "healthy";
  if (!botPollingActive) {
    status = "unhealthy";
  } else if (!allHealthy || tokenHealth.status !== "healthy") {
    status = "degraded";
  }

  return { status, components };
}

/** Start the health check HTTP server. */
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

    res.writeHead(404);
    res.end();
  });

  server.listen(HEALTH_PORT, () => {
    console.log(`Health server listening on port ${HEALTH_PORT}`);
  });
}
