import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PORT = parseInt(process.env.SURVEY_PORT || "3737");
const HTML_FILE = join(import.meta.dirname, "index.html");

// Outline API config — reuses same env vars as the bot
const OUTLINE_API_KEY = process.env.OUTLINE_API_KEY;
const OUTLINE_BASE_URL = process.env.OUTLINE_BASE_URL || "https://kb.xdeca.com/api";

// The parent document where all responses are stored as children
const PARENT_DOC_ID = process.env.SURVEY_PARENT_DOC_ID || "996d4ea6-8469-41be-8244-5de513d8aa67";
// The collection the survey lives in
const COLLECTION_ID = process.env.SURVEY_COLLECTION_ID || "a1392e39-42cd-4e41-b697-c5a5339ccacd";

interface SurveyResponse {
  user_id: string;
  user_name: string;
  submitted_at: string;
  [key: string]: unknown;
}

const USAGE_LABELS: Record<string, string> = {
  regular: "I use it regularly",
  read_only: "Aware — I read it but don't interact",
  aware_unused: "Aware — but don't use it",
  unaware: "Didn't know we had this",
};

const SPRINT_LENGTH_LABELS: Record<string, string> = {
  too_short: "Too short",
  about_right: "About right",
  too_long: "Too long",
};

const CEREMONIES_LABELS: Record<string, string> = {
  useful: "Yes, they help me stay aligned",
  mixed: "Some are useful, some aren't",
  not_useful: "Not really — I'd prefer a different approach",
};

function responseToMarkdown(data: SurveyResponse): string {
  const lines: string[] = [];
  const ts = new Date(data.submitted_at).toLocaleDateString("en-AU", {
    dateStyle: "medium",
  });

  lines.push(`Submitted: ${ts}\n`);

  lines.push(`## Tool Adoption\n`);

  lines.push(`### Kan (Task Board)`);
  lines.push(`**${USAGE_LABELS[data.kan as string] || "No answer"}**`);
  if (data.kan_comment) lines.push(`\n> ${data.kan_comment}\n`);
  else lines.push("");

  lines.push(`### Outline (Knowledge Base)`);
  lines.push(`**${USAGE_LABELS[data.outline as string] || "No answer"}**`);
  if (data.outline_comment) lines.push(`\n> ${data.outline_comment}\n`);
  else lines.push("");

  lines.push(`### Radicale (Calendar)`);
  lines.push(`**${USAGE_LABELS[data.radicale as string] || "No answer"}**`);
  if (data.radicale_comment) lines.push(`\n> ${data.radicale_comment}\n`);
  else lines.push("");

  lines.push(`## Gremlin (Sprint Bot)\n`);
  lines.push(`**Usage:** ${USAGE_LABELS[data.gremlin_usage as string] || "No answer"}`);
  if (data.gremlin_helpfulness) {
    lines.push(`**Helpfulness:** ${data.gremlin_helpfulness}/5`);
  }
  if (data.gremlin_improvement) {
    lines.push(`\n**What would make it better:**`);
    lines.push(`> ${data.gremlin_improvement}`);
  }
  lines.push("");

  lines.push(`## Sprint Process\n`);
  lines.push(`**Sprint length:** ${SPRINT_LENGTH_LABELS[data.sprint_length as string] || "No answer"}`);
  lines.push(`**Ceremonies:** ${CEREMONIES_LABELS[data.ceremonies as string] || "No answer"}`);
  if (data.ceremonies_comment) lines.push(`\n> ${data.ceremonies_comment}\n`);
  else lines.push("");

  lines.push(`## Open Floor\n`);
  if (data.one_change) {
    lines.push(`**One thing I'd change:**`);
    lines.push(`> ${data.one_change}\n`);
  }
  if (data.anything_else) {
    lines.push(`**Anything else:**`);
    lines.push(`> ${data.anything_else}\n`);
  }
  if (!data.one_change && !data.anything_else) {
    lines.push(`*No additional comments.*`);
  }

  // Embed raw JSON so we can prefill the form on re-edit
  lines.push(`\n---\n`);
  lines.push(`<!--survey-data:${JSON.stringify(data)}:survey-data-->`);

  return lines.join("\n");
}

function extractResponseData(docText: string): SurveyResponse | null {
  const match = docText.match(/<!--survey-data:(.*?):survey-data-->/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

// Outline API helpers

async function outlineRequest(endpoint: string, body: Record<string, unknown>) {
  const res = await fetch(`${OUTLINE_BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OUTLINE_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Outline API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function findResponseDoc(userName: string): Promise<{ id: string; text: string } | null> {
  const title = `Response — ${userName}`;
  const result = await outlineRequest("/documents.search", {
    query: title,
    collectionId: COLLECTION_ID,
  });
  const docs = result.data as Array<{ document: { id: string; title: string; text: string; parentDocumentId: string | null } }>;
  const match = docs.find(
    (d) => d.document.title === title && d.document.parentDocumentId === PARENT_DOC_ID
  );
  return match ? { id: match.document.id, text: match.document.text } : null;
}

async function saveResponseToOutline(data: SurveyResponse): Promise<void> {
  const title = `Response — ${data.user_name}`;
  const markdown = responseToMarkdown(data);
  const existing = await findResponseDoc(data.user_name);

  if (existing) {
    await outlineRequest("/documents.update", {
      id: existing.id,
      text: markdown,
    });
    console.log(`[survey] Updated Outline doc for ${data.user_name}`);
  } else {
    await outlineRequest("/documents.create", {
      title,
      text: markdown,
      collectionId: COLLECTION_ID,
      parentDocumentId: PARENT_DOC_ID,
      publish: true,
    });
    console.log(`[survey] Created Outline doc for ${data.user_name}`);
  }
}

async function checkExistingResponse(userId: string, userName: string): Promise<{ exists: boolean; response: SurveyResponse | null }> {
  const doc = await findResponseDoc(userName);
  if (!doc) return { exists: false, response: null };
  const response = extractResponseData(doc.text);
  return { exists: true, response };
}

const html = readFileSync(HTML_FILE, "utf-8");

const server = createServer((req, res) => {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  // Serve HTML
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { ...headers, "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  // Check if user has submitted
  if (req.method === "GET" && req.url?.startsWith("/api/responses/")) {
    const parts = req.url.split("/api/responses/")[1]?.split("?name=");
    const userId = parts?.[0] || "";
    const userName = decodeURIComponent(parts?.[1] || "");

    if (!userName) {
      res.writeHead(200, { ...headers, "Content-Type": "application/json" });
      res.end(JSON.stringify({ exists: false, response: null }));
      return;
    }

    checkExistingResponse(userId, userName)
      .then((result) => {
        res.writeHead(200, { ...headers, "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      })
      .catch((err) => {
        console.error(`[survey] Error checking response:`, err);
        res.writeHead(200, { ...headers, "Content-Type": "application/json" });
        res.end(JSON.stringify({ exists: false, response: null }));
      });
    return;
  }

  // Submit response
  if (req.method === "POST" && req.url === "/api/responses") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const data: SurveyResponse = JSON.parse(body);
        if (!data.user_id || !data.user_name) {
          res.writeHead(400, { ...headers, "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "user_id and user_name required" }));
          return;
        }

        if (!OUTLINE_API_KEY) {
          res.writeHead(500, { ...headers, "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "OUTLINE_API_KEY not configured" }));
          return;
        }

        saveResponseToOutline(data)
          .then(() => {
            res.writeHead(200, { ...headers, "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          })
          .catch((err) => {
            console.error(`[survey] Error saving to Outline:`, err);
            res.writeHead(500, { ...headers, "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Failed to save to Outline" }));
          });
      } catch {
        res.writeHead(400, { ...headers, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { ...headers, "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`[survey] Meta-Sprint Review survey running at http://localhost:${PORT}`);
  if (!OUTLINE_API_KEY) {
    console.warn(`[survey] WARNING: OUTLINE_API_KEY not set — submissions will fail`);
  }
});
