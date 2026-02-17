#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = process.env.KAN_BASE_URL || "https://kan.bn/api/v1";
const API_KEY = process.env.KAN_API_KEY;

if (!API_KEY) {
  console.error("KAN_API_KEY environment variable is required");
  process.exit(1);
}

async function kanFetch(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      ...options.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`kan.bn API error ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : { success: true };
}

const server = new McpServer({
  name: "kan",
  version: "1.0.0",
});

// --- Workspaces ---

server.tool(
  "kan_list_workspaces",
  "List all workspaces accessible to the authenticated user",
  {},
  async () => {
    const data = await kanFetch("/workspaces");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "kan_get_workspace",
  "Get a workspace by its public ID, including its boards",
  { workspace_id: z.string().min(12).describe("Workspace public ID") },
  async ({ workspace_id }) => {
    const data = await kanFetch(`/workspaces/${workspace_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "kan_search",
  "Search boards and cards by title within a workspace",
  {
    workspace_id: z.string().min(12).describe("Workspace public ID"),
    query: z.string().min(1).max(100).describe("Search query"),
    limit: z.number().min(1).max(50).optional().describe("Max results (default 20)"),
  },
  async ({ workspace_id, query, limit }) => {
    const params = new URLSearchParams({ query });
    if (limit) params.set("limit", String(limit));
    const data = await kanFetch(`/workspaces/${workspace_id}/search?${params}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- Boards ---

server.tool(
  "kan_list_boards",
  "List all boards in a workspace",
  {
    workspace_id: z.string().min(12).describe("Workspace public ID"),
    type: z.enum(["regular", "template"]).optional().describe("Board type filter"),
  },
  async ({ workspace_id, type }) => {
    const params = type ? `?type=${type}` : "";
    const data = await kanFetch(`/workspaces/${workspace_id}/boards${params}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "kan_get_board",
  "Get a board by its public ID, including lists, labels, and cards",
  {
    board_id: z.string().min(12).describe("Board public ID"),
  },
  async ({ board_id }) => {
    const data = await kanFetch(`/boards/${board_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "kan_create_board",
  "Create a new board in a workspace",
  {
    workspace_id: z.string().min(12).describe("Workspace public ID"),
    title: z.string().min(1).describe("Board title"),
    description: z.string().optional().describe("Board description"),
  },
  async ({ workspace_id, title, description }) => {
    const body = { title, workspacePublicId: workspace_id };
    if (description) body.description = description;
    const data = await kanFetch("/boards", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "kan_update_board",
  "Update a board's title or description",
  {
    board_id: z.string().min(12).describe("Board public ID"),
    title: z.string().min(1).optional().describe("New board title"),
    description: z.string().optional().describe("New board description"),
  },
  async ({ board_id, title, description }) => {
    const body = {};
    if (title) body.title = title;
    if (description !== undefined) body.description = description;
    const data = await kanFetch(`/boards/${board_id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "kan_delete_board",
  "Delete a board by its public ID",
  { board_id: z.string().min(12).describe("Board public ID") },
  async ({ board_id }) => {
    const data = await kanFetch(`/boards/${board_id}`, { method: "DELETE" });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- Lists ---

server.tool(
  "kan_create_list",
  "Create a new list on a board",
  {
    board_id: z.string().min(12).describe("Board public ID"),
    name: z.string().min(1).describe("List name"),
  },
  async ({ board_id, name }) => {
    const data = await kanFetch("/lists", {
      method: "POST",
      body: JSON.stringify({ name, boardPublicId: board_id }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "kan_update_list",
  "Update a list's name or position",
  {
    list_id: z.string().min(12).describe("List public ID"),
    name: z.string().min(1).optional().describe("New list name"),
    index: z.number().optional().describe("New position index"),
  },
  async ({ list_id, name, index }) => {
    const body = {};
    if (name) body.name = name;
    if (index !== undefined) body.index = index;
    const data = await kanFetch(`/lists/${list_id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "kan_delete_list",
  "Delete a list by its public ID",
  { list_id: z.string().min(12).describe("List public ID") },
  async ({ list_id }) => {
    const data = await kanFetch(`/lists/${list_id}`, { method: "DELETE" });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- Cards ---

server.tool(
  "kan_create_card",
  "Create a new card in a list",
  {
    list_id: z.string().min(12).describe("List public ID"),
    title: z.string().min(1).describe("Card title"),
    description: z.string().max(10000).optional().describe("Card description"),
    position: z.enum(["start", "end"]).optional().describe("Position in list (default: end)"),
    due_date: z.string().nullable().optional().describe("Due date (ISO 8601)"),
    label_ids: z.array(z.string().min(12)).optional().describe("Label public IDs to attach"),
    member_ids: z.array(z.string().min(12)).optional().describe("Member public IDs to assign"),
  },
  async ({ list_id, title, description, position, due_date, label_ids, member_ids }) => {
    const body = {
      title,
      listPublicId: list_id,
      description: description || "",
      position: position || "end",
      labelPublicIds: label_ids || [],
      memberPublicIds: member_ids || [],
    };
    if (due_date !== undefined) body.dueDate = due_date;
    const data = await kanFetch("/cards", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "kan_get_card",
  "Get a card by its public ID, including checklists, labels, and members",
  { card_id: z.string().min(12).describe("Card public ID") },
  async ({ card_id }) => {
    const data = await kanFetch(`/cards/${card_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "kan_update_card",
  "Update a card's title, description, position, list, or due date",
  {
    card_id: z.string().min(12).describe("Card public ID"),
    title: z.string().min(1).optional().describe("New card title"),
    description: z.string().optional().describe("New card description"),
    list_id: z.string().min(12).optional().describe("Move card to this list"),
    index: z.number().optional().describe("New position index in list"),
    due_date: z.string().nullable().optional().describe("Due date (ISO 8601) or null to remove"),
  },
  async ({ card_id, title, description, list_id, index, due_date }) => {
    const body = {};
    if (title) body.title = title;
    if (description !== undefined) body.description = description;
    if (list_id) body.listPublicId = list_id;
    if (index !== undefined) body.index = index;
    if (due_date !== undefined) body.dueDate = due_date;
    const data = await kanFetch(`/cards/${card_id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "kan_delete_card",
  "Delete a card by its public ID",
  { card_id: z.string().min(12).describe("Card public ID") },
  async ({ card_id }) => {
    const data = await kanFetch(`/cards/${card_id}`, { method: "DELETE" });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- Card Labels (toggle) ---

server.tool(
  "kan_toggle_card_label",
  "Add or remove a label from a card (toggles on each call)",
  {
    card_id: z.string().min(12).describe("Card public ID"),
    label_id: z.string().min(12).describe("Label public ID"),
  },
  async ({ card_id, label_id }) => {
    const data = await kanFetch(`/cards/${card_id}/labels/${label_id}`, {
      method: "PUT",
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- Card Members (toggle) ---

server.tool(
  "kan_toggle_card_member",
  "Add or remove a member from a card (toggles on each call)",
  {
    card_id: z.string().min(12).describe("Card public ID"),
    member_id: z.string().min(12).describe("Workspace member public ID"),
  },
  async ({ card_id, member_id }) => {
    const data = await kanFetch(`/cards/${card_id}/members/${member_id}`, {
      method: "PUT",
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- Comments ---

server.tool(
  "kan_add_comment",
  "Add a comment to a card",
  {
    card_id: z.string().min(12).describe("Card public ID"),
    comment: z.string().min(1).describe("Comment text"),
  },
  async ({ card_id, comment }) => {
    const data = await kanFetch(`/cards/${card_id}/comments`, {
      method: "POST",
      body: JSON.stringify({ comment }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- Labels ---

server.tool(
  "kan_create_label",
  "Create a new label on a board",
  {
    board_id: z.string().min(12).describe("Board public ID"),
    name: z.string().min(1).max(36).describe("Label name"),
    colour_code: z.string().length(7).describe("Hex colour code (e.g. #ff0000)"),
  },
  async ({ board_id, name, colour_code }) => {
    const data = await kanFetch("/labels", {
      method: "POST",
      body: JSON.stringify({ name, boardPublicId: board_id, colourCode: colour_code }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "kan_update_label",
  "Update a label's name or colour",
  {
    label_id: z.string().min(12).describe("Label public ID"),
    name: z.string().min(1).max(36).optional().describe("New label name"),
    colour_code: z.string().length(7).optional().describe("New hex colour code"),
  },
  async ({ label_id, name, colour_code }) => {
    const body = {};
    if (name) body.name = name;
    if (colour_code) body.colourCode = colour_code;
    const data = await kanFetch(`/labels/${label_id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "kan_delete_label",
  "Delete a label by its public ID",
  { label_id: z.string().min(12).describe("Label public ID") },
  async ({ label_id }) => {
    const data = await kanFetch(`/labels/${label_id}`, { method: "DELETE" });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- Checklists ---

server.tool(
  "kan_create_checklist",
  "Create a new checklist on a card",
  {
    card_id: z.string().min(12).describe("Card public ID"),
    name: z.string().min(1).max(255).describe("Checklist name"),
  },
  async ({ card_id, name }) => {
    const data = await kanFetch(`/cards/${card_id}/checklists`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "kan_add_checklist_item",
  "Add an item to a checklist",
  {
    checklist_id: z.string().min(12).describe("Checklist public ID"),
    title: z.string().min(1).max(500).describe("Item title"),
  },
  async ({ checklist_id, title }) => {
    const data = await kanFetch(`/checklists/${checklist_id}/items`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "kan_update_checklist_item",
  "Update a checklist item's title, completion status, or position",
  {
    item_id: z.string().min(12).describe("Checklist item public ID"),
    title: z.string().min(1).max(500).optional().describe("New item title"),
    completed: z.boolean().optional().describe("Mark as completed or not"),
    index: z.number().min(0).optional().describe("New position index"),
  },
  async ({ item_id, title, completed, index }) => {
    const body = {};
    if (title) body.title = title;
    if (completed !== undefined) body.completed = completed;
    if (index !== undefined) body.index = index;
    const data = await kanFetch(`/checklists/items/${item_id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "kan_delete_checklist",
  "Delete a checklist by its public ID",
  { checklist_id: z.string().min(12).describe("Checklist public ID") },
  async ({ checklist_id }) => {
    const data = await kanFetch(`/checklists/${checklist_id}`, { method: "DELETE" });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- Start server ---

const transport = new StdioServerTransport();
await server.connect(transport);
