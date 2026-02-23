import { readFile } from "fs/promises";
import { registerCustomTool } from "../agent/tool-registry.js";

/** Path where deploy-info.txt lands inside the Docker container. */
const DEPLOY_INFO_PATH = "/app/deploy-info.txt";

/** Maximum size returned to the agent (~50 KB). */
const MAX_LENGTH = 50_000;

/**
 * Parse the raw deploy-info.txt (key=value header lines, then `---` delimited
 * sections for stat summary and full diff) into a friendly format:
 *
 *   deployed: 2025-01-31 03:47 UTC
 *   commit: a3f9c2d
 *   changes:
 *   [diff here]
 */
function formatDeployInfo(raw: string): string {
  const lines = raw.split("\n");
  let sha = "unknown";
  let time = "unknown";
  const bodyLines: string[] = [];
  let pastHeader = false;

  for (const line of lines) {
    if (!pastHeader && line.startsWith("DEPLOY_SHA=")) {
      sha = line.slice("DEPLOY_SHA=".length).trim();
    } else if (!pastHeader && line.startsWith("DEPLOY_TIME=")) {
      time = line.slice("DEPLOY_TIME=".length).trim();
    } else if (!pastHeader && line === "---") {
      pastHeader = true;
    } else if (pastHeader) {
      bodyLines.push(line);
    }
  }

  // Format the timestamp for readability (drop the T and Z from ISO format)
  const displayTime = time.replace("T", " ").replace("Z", " UTC");

  return `deployed: ${displayTime}\ncommit: ${sha}\nchanges:\n${bodyLines.join("\n")}`;
}

/** Register the deploy info tool. */
export function registerDeployInfoTools(): void {
  registerCustomTool({
    name: "get_deploy_info",
    description:
      "Get the git diff and details of the current deployment. " +
      "Shows what changed in the latest deploy — commit SHA, timestamp, file stats, and full diff.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      try {
        const raw = await readFile(DEPLOY_INFO_PATH, "utf-8");
        const formatted = formatDeployInfo(raw);
        if (formatted.length > MAX_LENGTH) {
          return formatted.slice(0, MAX_LENGTH) + "\n\n[truncated — diff exceeded 50 KB]";
        }
        return formatted;
      } catch {
        return "No deploy info available (running outside of a deployed container).";
      }
    },
  });
}
