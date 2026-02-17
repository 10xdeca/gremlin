#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = process.env.OUTLINE_BASE_URL || "https://kb.xdeca.com/api";
const API_KEY = process.env.OUTLINE_API_KEY;

if (!API_KEY) {
  console.error("OUTLINE_API_KEY environment variable is required");
  process.exit(1);
}

/**
 * POST to the Outline RPC API.
 * All Outline endpoints use POST to /api/<method>.
 */
async function outlineFetch(method, body = {}) {
  const url = `${BASE_URL}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Outline API error ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : { ok: true };
}

/** Standard MCP response helper. */
function jsonResponse(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({
  name: "outline",
  version: "1.0.0",
});

// =============================================================================
// Documents (core)
// =============================================================================

server.tool(
  "outline_search",
  "Full-text search across all documents in the Outline wiki",
  {
    query: z.string().min(1).describe("Search query string"),
    collectionId: z.string().optional().describe("Filter to a specific collection ID"),
    dateFilter: z
      .enum(["day", "week", "month", "year"])
      .optional()
      .describe("Filter by recency"),
    offset: z.number().optional().describe("Pagination offset"),
    limit: z.number().min(1).max(25).optional().describe("Max results (default 25)"),
  },
  async ({ query, collectionId, dateFilter, offset, limit }) => {
    const body = { query };
    if (collectionId) body.collectionId = collectionId;
    if (dateFilter) body.dateFilter = dateFilter;
    if (offset !== undefined) body.offset = offset;
    if (limit !== undefined) body.limit = limit;
    const data = await outlineFetch("documents.search", body);
    return jsonResponse(data);
  }
);

server.tool(
  "outline_get_document",
  "Get a document by its ID, including full markdown content",
  {
    id: z.string().optional().describe("Document UUID"),
    shareId: z.string().optional().describe("Document share ID (alternative to id)"),
  },
  async ({ id, shareId }) => {
    const body = {};
    if (id) body.id = id;
    if (shareId) body.shareId = shareId;
    const data = await outlineFetch("documents.info", body);
    return jsonResponse(data);
  }
);

server.tool(
  "outline_list_documents",
  "List documents with optional filters (collection, backlinkDocumentId, etc.)",
  {
    collectionId: z.string().optional().describe("Filter by collection ID"),
    backlinkDocumentId: z
      .string()
      .optional()
      .describe("List documents that link to this document"),
    parentDocumentId: z
      .string()
      .optional()
      .describe("Filter by parent document ID"),
    sort: z.string().optional().describe("Sort field (e.g. updatedAt, title)"),
    direction: z.enum(["ASC", "DESC"]).optional().describe("Sort direction"),
    offset: z.number().optional().describe("Pagination offset"),
    limit: z.number().min(1).max(25).optional().describe("Max results (default 25)"),
  },
  async ({ collectionId, backlinkDocumentId, parentDocumentId, sort, direction, offset, limit }) => {
    const body = {};
    if (collectionId) body.collectionId = collectionId;
    if (backlinkDocumentId) body.backlinkDocumentId = backlinkDocumentId;
    if (parentDocumentId) body.parentDocumentId = parentDocumentId;
    if (sort) body.sort = sort;
    if (direction) body.direction = direction;
    if (offset !== undefined) body.offset = offset;
    if (limit !== undefined) body.limit = limit;
    const data = await outlineFetch("documents.list", body);
    return jsonResponse(data);
  }
);

server.tool(
  "outline_create_document",
  "Create a new document in a collection (markdown content)",
  {
    title: z.string().min(1).describe("Document title"),
    text: z.string().optional().describe("Document body in markdown"),
    collectionId: z.string().describe("Collection to create the document in"),
    parentDocumentId: z
      .string()
      .optional()
      .describe("Parent document ID for nesting"),
    publish: z
      .boolean()
      .optional()
      .describe("Publish immediately (default true)"),
  },
  async ({ title, text, collectionId, parentDocumentId, publish }) => {
    const body = { title, collectionId };
    if (text !== undefined) body.text = text;
    if (parentDocumentId) body.parentDocumentId = parentDocumentId;
    if (publish !== undefined) body.publish = publish;
    const data = await outlineFetch("documents.create", body);
    return jsonResponse(data);
  }
);

server.tool(
  "outline_update_document",
  "Update a document's title, content, or move it between collections",
  {
    id: z.string().describe("Document ID"),
    title: z.string().optional().describe("New title"),
    text: z.string().optional().describe("New markdown content (replaces entire body)"),
    append: z
      .boolean()
      .optional()
      .describe("If true, append text to existing content instead of replacing"),
    collectionId: z
      .string()
      .optional()
      .describe("Move document to this collection"),
    done: z.boolean().optional().describe("Mark as done (for tasks)"),
  },
  async ({ id, title, text, append, collectionId, done }) => {
    const body = { id };
    if (title !== undefined) body.title = title;
    if (text !== undefined) body.text = text;
    if (append !== undefined) body.append = append;
    if (collectionId) body.collectionId = collectionId;
    if (done !== undefined) body.done = done;
    const data = await outlineFetch("documents.update", body);
    return jsonResponse(data);
  }
);

server.tool(
  "outline_delete_document",
  "Delete a document (move to trash, or permanently if permanent=true)",
  {
    id: z.string().describe("Document ID"),
    permanent: z
      .boolean()
      .optional()
      .describe("Permanently delete instead of moving to trash"),
  },
  async ({ id, permanent }) => {
    const body = { id };
    if (permanent !== undefined) body.permanent = permanent;
    const data = await outlineFetch("documents.delete", body);
    return jsonResponse(data);
  }
);

server.tool(
  "outline_archive_document",
  "Archive a document",
  { id: z.string().describe("Document ID") },
  async ({ id }) => {
    const data = await outlineFetch("documents.archive", { id });
    return jsonResponse(data);
  }
);

server.tool(
  "outline_restore_document",
  "Restore an archived or deleted document",
  {
    id: z.string().describe("Document ID"),
    revisionId: z.string().optional().describe("Restore to a specific revision"),
  },
  async ({ id, revisionId }) => {
    const body = { id };
    if (revisionId) body.revisionId = revisionId;
    const data = await outlineFetch("documents.restore", body);
    return jsonResponse(data);
  }
);

server.tool(
  "outline_move_document",
  "Move a document to a different collection or parent",
  {
    id: z.string().describe("Document ID"),
    collectionId: z.string().optional().describe("Target collection ID"),
    parentDocumentId: z
      .string()
      .nullable()
      .optional()
      .describe("Target parent document ID, or null for top level"),
  },
  async ({ id, collectionId, parentDocumentId }) => {
    const body = { id };
    if (collectionId) body.collectionId = collectionId;
    if (parentDocumentId !== undefined) body.parentDocumentId = parentDocumentId;
    const data = await outlineFetch("documents.move", body);
    return jsonResponse(data);
  }
);

server.tool(
  "outline_list_drafts",
  "List the current user's draft documents",
  {
    sort: z.string().optional().describe("Sort field (e.g. updatedAt)"),
    direction: z.enum(["ASC", "DESC"]).optional().describe("Sort direction"),
    offset: z.number().optional().describe("Pagination offset"),
    limit: z.number().min(1).max(25).optional().describe("Max results"),
  },
  async ({ sort, direction, offset, limit }) => {
    const body = {};
    if (sort) body.sort = sort;
    if (direction) body.direction = direction;
    if (offset !== undefined) body.offset = offset;
    if (limit !== undefined) body.limit = limit;
    const data = await outlineFetch("documents.drafts", body);
    return jsonResponse(data);
  }
);

server.tool(
  "outline_list_viewed",
  "List recently viewed documents",
  {
    offset: z.number().optional().describe("Pagination offset"),
    limit: z.number().min(1).max(25).optional().describe("Max results"),
  },
  async ({ offset, limit }) => {
    const body = {};
    if (offset !== undefined) body.offset = offset;
    if (limit !== undefined) body.limit = limit;
    const data = await outlineFetch("documents.viewed", body);
    return jsonResponse(data);
  }
);

// =============================================================================
// Collections
// =============================================================================

server.tool(
  "outline_list_collections",
  "List all accessible collections in the Outline wiki",
  {
    offset: z.number().optional().describe("Pagination offset"),
    limit: z.number().min(1).max(100).optional().describe("Max results"),
  },
  async ({ offset, limit }) => {
    const body = {};
    if (offset !== undefined) body.offset = offset;
    if (limit !== undefined) body.limit = limit;
    const data = await outlineFetch("collections.list", body);
    return jsonResponse(data);
  }
);

server.tool(
  "outline_get_collection",
  "Get collection details by ID",
  { id: z.string().describe("Collection ID") },
  async ({ id }) => {
    const data = await outlineFetch("collections.info", { id });
    return jsonResponse(data);
  }
);

server.tool(
  "outline_create_collection",
  "Create a new collection",
  {
    name: z.string().min(1).describe("Collection name"),
    description: z.string().optional().describe("Collection description (markdown)"),
    color: z.string().optional().describe("Hex color code (e.g. #123456)"),
    permission: z
      .enum(["read", "read_write"])
      .optional()
      .describe("Default access permission for workspace members"),
  },
  async ({ name, description, color, permission }) => {
    const body = { name };
    if (description !== undefined) body.description = description;
    if (color) body.color = color;
    if (permission) body.permission = permission;
    const data = await outlineFetch("collections.create", body);
    return jsonResponse(data);
  }
);

server.tool(
  "outline_update_collection",
  "Update a collection's name, description, color, or permissions",
  {
    id: z.string().describe("Collection ID"),
    name: z.string().min(1).optional().describe("New collection name"),
    description: z.string().optional().describe("New description (markdown)"),
    color: z.string().optional().describe("New hex color code"),
    permission: z
      .enum(["read", "read_write"])
      .optional()
      .describe("Default access permission"),
  },
  async ({ id, name, description, color, permission }) => {
    const body = { id };
    if (name) body.name = name;
    if (description !== undefined) body.description = description;
    if (color) body.color = color;
    if (permission) body.permission = permission;
    const data = await outlineFetch("collections.update", body);
    return jsonResponse(data);
  }
);

server.tool(
  "outline_delete_collection",
  "Delete a collection and all its documents",
  { id: z.string().describe("Collection ID") },
  async ({ id }) => {
    const data = await outlineFetch("collections.delete", { id });
    return jsonResponse(data);
  }
);

server.tool(
  "outline_get_collection_documents",
  "Get the document hierarchy (tree) within a collection",
  { id: z.string().describe("Collection ID") },
  async ({ id }) => {
    const data = await outlineFetch("collections.documents", { id });
    return jsonResponse(data);
  }
);

// =============================================================================
// Comments
// =============================================================================

server.tool(
  "outline_list_comments",
  "List comments on a document",
  {
    documentId: z.string().describe("Document ID"),
    offset: z.number().optional().describe("Pagination offset"),
    limit: z.number().min(1).max(25).optional().describe("Max results"),
  },
  async ({ documentId, offset, limit }) => {
    const body = { documentId };
    if (offset !== undefined) body.offset = offset;
    if (limit !== undefined) body.limit = limit;
    const data = await outlineFetch("comments.list", body);
    return jsonResponse(data);
  }
);

server.tool(
  "outline_create_comment",
  "Add a comment to a document",
  {
    documentId: z.string().describe("Document ID"),
    data: z.string().min(1).describe("Comment text (markdown)"),
  },
  async ({ documentId, data: commentData }) => {
    const data = await outlineFetch("comments.create", {
      documentId,
      data: commentData,
    });
    return jsonResponse(data);
  }
);

// =============================================================================
// Users & Team
// =============================================================================

server.tool(
  "outline_list_users",
  "List workspace users",
  {
    query: z.string().optional().describe("Filter users by name"),
    offset: z.number().optional().describe("Pagination offset"),
    limit: z.number().min(1).max(100).optional().describe("Max results"),
  },
  async ({ query, offset, limit }) => {
    const body = {};
    if (query) body.query = query;
    if (offset !== undefined) body.offset = offset;
    if (limit !== undefined) body.limit = limit;
    const data = await outlineFetch("users.list", body);
    return jsonResponse(data);
  }
);

// =============================================================================
// Revisions
// =============================================================================

server.tool(
  "outline_list_revisions",
  "List revision history for a document",
  {
    documentId: z.string().describe("Document ID"),
    offset: z.number().optional().describe("Pagination offset"),
    limit: z.number().min(1).max(25).optional().describe("Max results"),
  },
  async ({ documentId, offset, limit }) => {
    const body = { documentId };
    if (offset !== undefined) body.offset = offset;
    if (limit !== undefined) body.limit = limit;
    const data = await outlineFetch("revisions.list", body);
    return jsonResponse(data);
  }
);

// =============================================================================
// Start server
// =============================================================================

const transport = new StdioServerTransport();
await server.connect(transport);
