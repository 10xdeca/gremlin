/**
 * Server operations tools — self-diagnostics and self-repair.
 *
 * Gives the agent the ability to:
 * - Read its own Docker container logs
 * - Check container status (uptime, restart count)
 * - Health-check individual MCP server subprocesses
 * - Restart a specific MCP server (surgical repair)
 * - Restart the entire container (nuclear option)
 */

import { registerCustomTool } from "../agent/tool-registry.js";
import { mcpManager } from "../agent/mcp-manager.js";
import {
  getContainerLogs,
  getContainerInfo,
  restartContainer,
} from "../utils/docker.js";

/** Register all server operations tools. */
export function registerServerOpsTools(): void {
  // --- get_server_logs ---
  registerCustomTool({
    name: "get_server_logs",
    description:
      "Read the bot's Docker container logs. Useful for diagnosing errors, " +
      "crashes, or unexpected behavior. Returns recent log lines with timestamps.",
    inputSchema: {
      type: "object",
      properties: {
        tail: {
          type: "number",
          description: "Number of recent log lines to fetch (default 100, max 1000)",
        },
        filter: {
          type: "string",
          description: "Optional text filter — only lines containing this string are returned",
        },
      },
    },
    handler: async (args) => {
      const tail = Math.min(Number(args.tail) || 100, 1000);
      const filter = typeof args.filter === "string" ? args.filter : undefined;
      return getContainerLogs(tail, filter);
    },
  });

  // --- get_container_status ---
  registerCustomTool({
    name: "get_container_status",
    description:
      "Get the bot's Docker container status: running state, uptime, restart count, " +
      "and creation timestamp. Useful for understanding overall health.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      const info = await getContainerInfo();
      if (typeof info === "string") return info; // Error message
      return JSON.stringify(info, null, 2);
    },
  });

  // --- check_mcp_health ---
  registerCustomTool({
    name: "check_mcp_health",
    description:
      "Health-check MCP server subprocesses (kan, outline, radicale). " +
      "Pings each server to verify it's responsive. This is the first tool to use " +
      "when a tool call fails — it reveals which server is down.",
    inputSchema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description:
            "Optional: check a specific server (kan, outline, radicale). " +
            "Omit to check all servers.",
        },
      },
    },
    handler: async (args) => {
      const serverName = typeof args.server === "string" ? args.server : undefined;
      const results = await mcpManager.healthCheck(serverName);
      return JSON.stringify(results, null, 2);
    },
  });

  // --- restart_mcp_server ---
  registerCustomTool({
    name: "restart_mcp_server",
    description:
      "Restart a specific MCP server subprocess (kan, outline, or radicale). " +
      "This is the primary self-repair action — fast and surgical with no downtime " +
      "for other servers. Use after check_mcp_health reveals an unhealthy server.",
    inputSchema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "The MCP server to restart: kan, outline, or radicale",
        },
      },
      required: ["server"],
    },
    handler: async (args) => {
      const serverName = typeof args.server === "string" ? args.server : "";
      const validServers = mcpManager.getServerNames();

      if (!validServers.includes(serverName)) {
        return `Invalid server name "${serverName}". Valid servers: ${validServers.join(", ")}`;
      }

      const result = await mcpManager.restartServer(serverName);
      return JSON.stringify(result);
    },
  });

  // --- restart_bot ---
  registerCustomTool({
    name: "restart_bot",
    description:
      "Restart the entire bot container. This is the NUCLEAR option — only use when " +
      "MCP server restarts don't fix the issue. The bot will be unavailable for ~10-15 seconds. " +
      "For user-initiated requests, only admins may ask for this. " +
      "The agent may use this autonomously if diagnostics warrant it.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      // Schedule the restart with a 3-second delay so the agent can respond first
      setTimeout(async () => {
        const result = await restartContainer();
        console.log(`restart_bot: ${result}`);
      }, 3000);

      return "Container restart scheduled in 3 seconds. The bot will be back shortly.";
    },
  });
}
