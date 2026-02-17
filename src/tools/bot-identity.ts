import { registerCustomTool } from "../agent/tool-registry.js";
import { getBotIdentity } from "../services/bot-identity.js";

/** Register bot identity tools. */
export function registerBotIdentityTools(): void {
  registerCustomTool({
    name: "get_bot_identity",
    description:
      "Get the bot's current identity (name, pronouns, tone, tone description). Used to stay in character.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      const identity = await getBotIdentity();
      return JSON.stringify(identity);
    },
  });
}
