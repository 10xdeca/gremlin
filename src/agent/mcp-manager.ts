import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerHealth {
  name: string;
  status: "healthy" | "unhealthy" | "stopped";
  toolCount: number;
  error?: string;
}

interface McpServerConfig {
  name: string;
  /** Path to the MCP server entry file (index.js) */
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface ManagedServer {
  config: McpServerConfig;
  client: Client;
  transport: StdioClientTransport;
  tools: McpTool[];
}

/** MCP Manager — spawns and manages MCP server subprocesses. */
class McpManager {
  private servers = new Map<string, ManagedServer>();

  /** Start all configured MCP servers and discover their tools. */
  async init(): Promise<void> {
    const configs = this.getServerConfigs();

    for (const config of configs) {
      await this.startServer(config);
    }

    const toolCount = Array.from(this.servers.values()).reduce(
      (sum, s) => sum + s.tools.length,
      0
    );
    console.log(
      `MCP Manager: ${this.servers.size} servers started, ${toolCount} tools available`
    );
  }

  /** Get the list of all available MCP tools across all servers. */
  getAllTools(): McpTool[] {
    const tools: McpTool[] = [];
    for (const server of this.servers.values()) {
      tools.push(...server.tools);
    }
    return tools;
  }

  /** Call a tool by name, routing to the correct MCP server. */
  async callTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<string> {
    for (const server of this.servers.values()) {
      const hasTool = server.tools.some((t) => t.name === toolName);
      if (hasTool) {
        const result = await server.client.callTool({
          name: toolName,
          arguments: args,
        });

        // MCP tools return content blocks — extract text
        const textParts = (result.content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text!);

        return textParts.join("\n") || JSON.stringify(result);
      }
    }

    throw new Error(`MCP tool not found: ${toolName}`);
  }

  /** Get the MCP client for a specific server (used by scheduler for direct calls). */
  getClient(serverName: string): Client | null {
    return this.servers.get(serverName)?.client ?? null;
  }

  /** Get the names of all configured MCP servers. */
  getServerNames(): string[] {
    return Array.from(this.servers.keys());
  }

  /**
   * Health-check one or all MCP servers by pinging `listTools()`.
   * Each ping is capped at 5 seconds to avoid blocking on a hung subprocess.
   */
  async healthCheck(serverName?: string): Promise<McpServerHealth[]> {
    const targets = serverName
      ? [serverName]
      : Array.from(this.servers.keys());

    const results: McpServerHealth[] = [];

    for (const name of targets) {
      const server = this.servers.get(name);
      if (!server) {
        results.push({ name, status: "stopped", toolCount: 0, error: "Server not found" });
        continue;
      }
      try {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Health check timed out (5s)")), 5000)
        );
        const toolsResult = await Promise.race([server.client.listTools(), timeout]);
        results.push({
          name,
          status: "healthy",
          toolCount: toolsResult.tools.length,
        });
      } catch (err) {
        results.push({
          name,
          status: "unhealthy",
          toolCount: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  /**
   * Restart a specific MCP server subprocess.
   * Closes the existing transport, removes it from the map, and re-starts with the stored config.
   */
  async restartServer(serverName: string): Promise<{ success: boolean; message: string }> {
    const server = this.servers.get(serverName);
    if (!server) {
      return { success: false, message: `Server "${serverName}" not found` };
    }

    const { config } = server;

    // Tear down the existing server
    try {
      await server.transport.close();
    } catch {
      // Ignore close errors — the server may already be dead
    }
    this.servers.delete(serverName);

    // Restart with the stored config
    // Note: startServer() catches errors internally and logs them without re-throwing,
    // so we check the map afterwards to detect silent failures.
    await this.startServer(config);

    if (!this.servers.has(serverName)) {
      console.error(`MCP Manager: ${serverName} failed to restart (not in server map)`);
      return { success: false, message: `Failed to restart ${serverName} — server did not come back up` };
    }

    const toolCount = this.servers.get(serverName)!.tools.length;
    console.log(`MCP Manager: restarted ${serverName} with ${toolCount} tools`);
    return { success: true, message: `Restarted ${serverName} with ${toolCount} tools` };
  }

  /** Shut down all MCP servers. */
  async shutdown(): Promise<void> {
    for (const [name, server] of this.servers) {
      try {
        await server.transport.close();
        console.log(`MCP Manager: shut down ${name}`);
      } catch (err) {
        console.error(`MCP Manager: error shutting down ${name}:`, err);
      }
    }
    this.servers.clear();
  }

  private getServerConfigs(): McpServerConfig[] {
    const mcpRoot = resolve(__dirname, "../../mcp-servers/packages");
    const configs: McpServerConfig[] = [];

    // Kan MCP server
    const kanApiKey = process.env.KAN_API_KEY || process.env.KAN_SERVICE_API_KEY;
    if (kanApiKey) {
      configs.push({
        name: "kan",
        command: "node",
        args: [resolve(mcpRoot, "kan/index.js")],
        env: {
          KAN_BASE_URL: process.env.KAN_BASE_URL || "https://tasks.xdeca.com/api/v1",
          KAN_API_KEY: kanApiKey,
        },
      });
    } else {
      console.warn("MCP Manager: KAN_API_KEY not set, skipping Kan MCP server");
    }

    // Outline MCP server
    const outlineApiKey = process.env.OUTLINE_API_KEY;
    if (outlineApiKey) {
      configs.push({
        name: "outline",
        command: "node",
        args: [resolve(mcpRoot, "outline/index.js")],
        env: {
          OUTLINE_BASE_URL: process.env.OUTLINE_BASE_URL || "https://kb.xdeca.com/api",
          OUTLINE_API_KEY: outlineApiKey,
        },
      });
    } else {
      console.warn("MCP Manager: OUTLINE_API_KEY not set, skipping Outline MCP server");
    }

    // Radicale MCP server
    const radicalePassword = process.env.RADICALE_PASSWORD;
    if (radicalePassword) {
      configs.push({
        name: "radicale",
        command: "node",
        args: [resolve(mcpRoot, "radicale/index.js")],
        env: {
          RADICALE_URL: process.env.RADICALE_URL || "https://dav.xdeca.com",
          RADICALE_USERNAME: process.env.RADICALE_USERNAME || "pm-agent",
          RADICALE_PASSWORD: radicalePassword,
          ...(process.env.RADICALE_CALENDAR_OWNER
            ? { RADICALE_CALENDAR_OWNER: process.env.RADICALE_CALENDAR_OWNER }
            : {}),
        },
      });
    } else {
      console.warn("MCP Manager: RADICALE_PASSWORD not set, skipping Radicale MCP server");
    }

    return configs;
  }

  async startServer(config: McpServerConfig): Promise<void> {
    try {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...process.env, ...config.env } as Record<string, string>,
      });

      const client = new Client({
        name: `xdeca-pm-bot-${config.name}`,
        version: "1.0.0",
      });

      await client.connect(transport);

      // Discover tools
      const toolsResult = await client.listTools();
      const tools: McpTool[] = toolsResult.tools.map((t) => ({
        name: t.name,
        description: t.description || "",
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));

      this.servers.set(config.name, { config, client, transport, tools });
      console.log(
        `MCP Manager: ${config.name} started with ${tools.length} tools`
      );
    } catch (err) {
      console.error(`MCP Manager: failed to start ${config.name}:`, err);
    }
  }
}

/** Singleton MCP manager instance. */
export const mcpManager = new McpManager();
