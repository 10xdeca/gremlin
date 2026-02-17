import { registerCustomTool } from "../agent/tool-registry.js";
import { getSprintInfo } from "../utils/sprint.js";

/** Register sprint info tools. */
export function registerSprintInfoTools(): void {
  registerCustomTool({
    name: "get_sprint_info",
    description:
      "Get current sprint status: day number (1-14), whether it's the planning window (days 1-2), mid-sprint, sprint end, or break day.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      const info = getSprintInfo();
      return JSON.stringify(info);
    },
  });
}
