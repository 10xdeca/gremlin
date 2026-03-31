import { tool, jsonSchema } from "ai";
import type { ToolSet } from "ai";
import type { Api } from "grammy";
import { mcpManager, type McpTool } from "./mcp-manager.js";

/** A custom (non-MCP) tool definition. */
export interface CustomToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

const customTools = new Map<string, CustomToolDef>();

/** Register a custom tool (called at startup from src/tools/*.ts). */
export function registerCustomTool(tool: CustomToolDef): void {
  customTools.set(tool.name, tool);
}

/** Fire-and-forget typing indicator. */
function sendTyping(api: Api, chatId: number): void {
  api.sendChatAction(chatId, "typing").catch(() => {
    // Typing indicator failures are not critical
  });
}

/**
 * Build the tools record for generateText().
 * Each tool has its execute function baked in — the SDK calls it automatically.
 * Typing indicators fire at the start of each tool execution.
 */
export function getTools(chatId: number, api: Api): ToolSet {
  const tools: ToolSet = {};

  // MCP tools — route execution through mcpManager
  for (const mcpTool of mcpManager.getAllTools()) {
    const name = mcpTool.name;
    tools[name] = tool({
      description: mcpTool.description,
      inputSchema: jsonSchema(mcpTool.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: async (args: Record<string, unknown>) => {
        sendTyping(api, chatId);
        console.log(`Tool call: ${name}(${JSON.stringify(args)})`);
        try {
          return await mcpManager.callTool(name, args);
        } catch (err) {
          const msg = `Error: ${err instanceof Error ? err.message : String(err)}`;
          console.error(`Tool ${name} failed:`, err);
          return msg;
        }
      },
    });
  }

  // Custom tools — use their handler directly
  for (const custom of customTools.values()) {
    const name = custom.name;
    const handler = custom.handler;
    tools[name] = tool({
      description: custom.description,
      inputSchema: jsonSchema(custom.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: async (args: Record<string, unknown>) => {
        sendTyping(api, chatId);
        console.log(`Tool call: ${name}(${JSON.stringify(args)})`);
        try {
          return await handler(args);
        } catch (err) {
          const msg = `Error: ${err instanceof Error ? err.message : String(err)}`;
          console.error(`Tool ${name} failed:`, err);
          return msg;
        }
      },
    });
  }

  return tools;
}
