/**
 * GitHub repository tools — read code, browse files, manage issues.
 *
 * Gives the agent the ability to:
 * - Read any file from its own repo (or other org repos)
 * - List directory contents to navigate the codebase
 * - Create and list GitHub issues
 *
 * Uses the GitHub REST API with a fine-grained PAT.
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
async function ghFetch(
  path: string,
  options?: { method?: string; body?: Record<string, unknown> },
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "gremlin-bot",
  };
  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }
  if (options?.body) {
    headers["Content-Type"] = "application/json";
  }
  return fetch(`${API_BASE}${path}`, {
    method: options?.method || "GET",
    headers,
    ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
  });
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

  // --- create_github_issue ---
  registerCustomTool({
    name: "create_github_issue",
    description:
      "Create a new issue on a GitHub repository. " +
      "Use this to file bugs, feature requests, or track tasks. " +
      "Returns the issue number and URL.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Issue title",
        },
        body: {
          type: "string",
          description: "Issue body (supports GitHub Markdown)",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Labels to apply (e.g. ['bug', 'priority:high']). Labels must already exist on the repo.",
        },
        assignees: {
          type: "array",
          items: { type: "string" },
          description: "GitHub usernames to assign",
        },
        repo: {
          type: "string",
          description: `Repository in owner/name format (default: ${DEFAULT_REPO})`,
        },
      },
      required: ["title"],
    },
    handler: async (args) => {
      const repo = String(args.repo || DEFAULT_REPO);
      const payload: Record<string, unknown> = {
        title: String(args.title),
      };
      if (args.body) payload.body = String(args.body);
      if (Array.isArray(args.labels) && args.labels.length > 0) payload.labels = args.labels;
      if (Array.isArray(args.assignees) && args.assignees.length > 0) payload.assignees = args.assignees;

      const res = await ghFetch(`/repos/${repo}/issues`, {
        method: "POST",
        body: payload,
      });

      if (!res.ok) {
        const errText = await res.text();
        return `Failed to create issue: ${res.status} ${res.statusText}\n${errText}`;
      }

      const issue = await res.json() as { number: number; html_url: string; title: string };
      return JSON.stringify({
        success: true,
        number: issue.number,
        url: issue.html_url,
        title: issue.title,
      }, null, 2);
    },
  });

  // --- list_github_issues ---
  registerCustomTool({
    name: "list_github_issues",
    description:
      "List issues on a GitHub repository. " +
      "Useful for checking existing bugs, finding duplicates before creating new issues, " +
      "or reviewing open work.",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          description: "Filter by state: 'open', 'closed', or 'all' (default: 'open')",
        },
        labels: {
          type: "string",
          description: "Comma-separated label names to filter by (e.g. 'bug,priority:high')",
        },
        limit: {
          type: "number",
          description: "Max issues to return (default: 10, max: 30)",
        },
        repo: {
          type: "string",
          description: `Repository in owner/name format (default: ${DEFAULT_REPO})`,
        },
      },
    },
    handler: async (args) => {
      const repo = String(args.repo || DEFAULT_REPO);
      const state = String(args.state || "open");
      const limit = Math.min(Number(args.limit) || 10, 30);
      const params = new URLSearchParams({
        state,
        per_page: String(limit),
        sort: "updated",
        direction: "desc",
      });
      if (args.labels) params.set("labels", String(args.labels));

      const res = await ghFetch(`/repos/${repo}/issues?${params}`);
      if (!res.ok) {
        return `GitHub API error: ${res.status} ${res.statusText}`;
      }

      const issues = await res.json() as Array<{
        number: number; title: string; state: string;
        html_url: string; labels: Array<{ name: string }>;
        assignees: Array<{ login: string }>; created_at: string; updated_at: string;
        pull_request?: unknown;
      }>;

      // Filter out pull requests (GitHub API returns PRs as issues)
      const realIssues = issues.filter((i) => !i.pull_request);

      if (realIssues.length === 0) {
        return `No ${state} issues found${args.labels ? ` with labels: ${args.labels}` : ""} in ${repo}`;
      }

      const lines = realIssues.map((i) => {
        const labels = i.labels.map((l) => l.name).join(", ");
        const assignees = i.assignees.map((a) => a.login).join(", ");
        return [
          `#${i.number}: ${i.title}`,
          `  State: ${i.state} | Updated: ${i.updated_at.slice(0, 10)}`,
          labels ? `  Labels: ${labels}` : "",
          assignees ? `  Assigned: ${assignees}` : "",
          `  ${i.html_url}`,
        ].filter(Boolean).join("\n");
      });

      return `${realIssues.length} issue(s) in ${repo}:\n\n${lines.join("\n\n")}`;
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
