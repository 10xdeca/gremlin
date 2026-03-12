/**
 * GitHub repository tools — read source code and browse files.
 *
 * Gives the agent the ability to:
 * - Read any file from its own repo (or other org repos)
 * - List directory contents to navigate the codebase
 *
 * Uses the GitHub REST API (Contents endpoint) with a fine-grained PAT.
 * No `gh` CLI needed — just fetch.
 */

import { registerCustomTool } from "../agent/tool-registry.js";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DEFAULT_REPO = process.env.GITHUB_REPO || "10xdeca/gremlin";
const DEFAULT_BRANCH = process.env.GITHUB_BRANCH || "main";

/** Maximum file size returned to the agent (~100 KB). */
const MAX_FILE_SIZE = 100_000;

/** GitHub API base URL. */
const API_BASE = "https://api.github.com";

/** Make an authenticated GitHub API request. */
async function ghFetch(path: string): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "gremlin-bot",
  };
  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }
  return fetch(`${API_BASE}${path}`, { headers });
}

/** Register all GitHub repository tools. */
export function registerGitHubRepoTools(): void {
  if (!GITHUB_TOKEN) {
    console.log("GITHUB_TOKEN not set — GitHub repo tools disabled");
    return;
  }

  // --- read_repo_file ---
  registerCustomTool({
    name: "read_repo_file",
    description:
      "Read a file from a GitHub repository. Returns the file content as text. " +
      "Use this to read source code, config files, docs, etc. " +
      "Defaults to the gremlin repo on main branch.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to repo root (e.g. 'src/agent/agent-loop.ts')",
        },
        repo: {
          type: "string",
          description: `Repository in owner/name format (default: ${DEFAULT_REPO})`,
        },
        ref: {
          type: "string",
          description: `Branch, tag, or commit SHA (default: ${DEFAULT_BRANCH})`,
        },
      },
      required: ["path"],
    },
    handler: async (args) => {
      const path = String(args.path).replace(/^\//, "");
      const repo = String(args.repo || DEFAULT_REPO);
      const ref = String(args.ref || DEFAULT_BRANCH);

      const res = await ghFetch(`/repos/${repo}/contents/${encodeURI(path)}?ref=${ref}`);
      if (!res.ok) {
        if (res.status === 404) return `File not found: ${path} (repo: ${repo}, ref: ${ref})`;
        return `GitHub API error: ${res.status} ${res.statusText}`;
      }

      const data = await res.json() as { type: string; content?: string; size: number; encoding?: string };

      if (Array.isArray(data)) {
        return `"${path}" is a directory, not a file. Use list_repo_files instead.`;
      }

      if (data.type !== "file") {
        return `"${path}" is a ${data.type}, not a file.`;
      }

      if (!data.content) {
        return `File "${path}" is too large for the Contents API (${data.size} bytes). Try a smaller file.`;
      }

      const content = Buffer.from(data.content, "base64").toString("utf-8");
      if (content.length > MAX_FILE_SIZE) {
        return content.slice(0, MAX_FILE_SIZE) + `\n\n[truncated — file is ${data.size} bytes, showing first ${MAX_FILE_SIZE}]`;
      }
      return content;
    },
  });

  // --- list_repo_files ---
  registerCustomTool({
    name: "list_repo_files",
    description:
      "List files and directories in a GitHub repository path. " +
      "Returns names, types (file/dir), and sizes. " +
      "Use this to explore the codebase structure before reading specific files.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to repo root (e.g. 'src/tools'). Empty or '/' for root.",
        },
        repo: {
          type: "string",
          description: `Repository in owner/name format (default: ${DEFAULT_REPO})`,
        },
        ref: {
          type: "string",
          description: `Branch, tag, or commit SHA (default: ${DEFAULT_BRANCH})`,
        },
      },
    },
    handler: async (args) => {
      const path = String(args.path || "").replace(/^\//, "");
      const repo = String(args.repo || DEFAULT_REPO);
      const ref = String(args.ref || DEFAULT_BRANCH);

      const apiPath = path
        ? `/repos/${repo}/contents/${encodeURI(path)}?ref=${ref}`
        : `/repos/${repo}/contents?ref=${ref}`;

      const res = await ghFetch(apiPath);
      if (!res.ok) {
        if (res.status === 404) return `Path not found: ${path || "/"} (repo: ${repo}, ref: ${ref})`;
        return `GitHub API error: ${res.status} ${res.statusText}`;
      }

      const data = await res.json() as Array<{ name: string; type: string; size: number; path: string }>;

      if (!Array.isArray(data)) {
        return `"${path}" is a file, not a directory. Use read_repo_file instead.`;
      }

      const lines = data.map((item) => {
        const icon = item.type === "dir" ? "📁" : "📄";
        const size = item.type === "file" ? ` (${formatSize(item.size)})` : "";
        return `${icon} ${item.name}${size}`;
      });

      return `${path || "/"} (${data.length} items):\n${lines.join("\n")}`;
    },
  });
}

/** Format bytes to human-readable size. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
