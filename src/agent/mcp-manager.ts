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
    const mcpRoot = resolve(__dirname, "../../mcp-servers");
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

    return configs;
  }

  private async startServer(config: McpServerConfig): Promise<void> {
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
