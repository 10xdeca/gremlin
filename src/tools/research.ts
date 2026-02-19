import type { Api } from "grammy";
import { registerCustomTool } from "../agent/tool-registry.js";
import { conductResearch } from "../a2a/research-negotiator.js";

/**
 * Register the research tool. Requires bot.api to be passed in
 * so the negotiator can send Telegram progress messages.
 *
 * Only registers if RESEARCH_AGENT_URL is configured.
 */
export function registerResearchTool(api: Api): void {
  if (!process.env.RESEARCH_AGENT_URL) {
    console.log("RESEARCH_AGENT_URL not set — research tool disabled");
    return;
  }

  registerCustomTool({
    name: "research",
    description:
      "Delegate deep research to a dedicated agent that searches the web and team wiki. " +
      "Use this when the user needs information you don't have, or questions that need " +
      "investigation across multiple sources. Returns a structured research report. " +
      "This may take 30-120 seconds.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The research question or topic to investigate",
        },
        context: {
          type: "string",
          description:
            "Optional additional context to help focus the research (e.g. team name, project area)",
        },
        chat_id: {
          type: "number",
          description: "Telegram chat ID for sending progress updates",
        },
        message_thread_id: {
          type: "number",
          description: "Telegram message thread ID (for topic-based chats)",
        },
      },
      required: ["query", "chat_id"],
    },
    handler: async (args) => {
      try {
        const report = await conductResearch(api, {
          query: args.query as string,
          context: args.context as string | undefined,
          chatId: args.chat_id as number,
          messageThreadId: args.message_thread_id as number | undefined,
        });
        return report;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Research tool failed:", msg);
        return `Research could not be completed: ${msg}`;
      }
    },
  });

  console.log("Research tool registered (A2A)");
}
