import type Anthropic from "@anthropic-ai/sdk";
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

/**
 * Build the `tools` array for `anthropic.messages.create()`.
 * Merges MCP-discovered tools + registered custom tools.
 */
export function getAnthropicTools(): Anthropic.Messages.Tool[] {
  const tools: Anthropic.Messages.Tool[] = [];

  // MCP tools
  for (const mcpTool of mcpManager.getAllTools()) {
    tools.push(mcpToolToAnthropic(mcpTool));
  }

  // Custom tools
  for (const custom of customTools.values()) {
    tools.push({
      name: custom.name,
      description: custom.description,
      input_schema: custom.inputSchema as Anthropic.Messages.Tool["input_schema"],
    });
  }

  return tools;
}

/**
 * Execute a tool call — routes to MCP server or custom handler.
 * Returns the text result.
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  // Check custom tools first (fast path)
  const custom = customTools.get(toolName);
  if (custom) {
    return custom.handler(args);
  }

  // Route to MCP
  return mcpManager.callTool(toolName, args);
}

/** Convert an MCP tool schema to Anthropic tool format. */
export function mcpToolToAnthropic(tool: McpTool): Anthropic.Messages.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Messages.Tool["input_schema"],
  };
}
