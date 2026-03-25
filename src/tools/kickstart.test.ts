import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB client with an in-memory SQLite (same pattern as smoke.test.ts)
vi.mock("../db/client.js", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const schema = await import("../db/schema.js");

  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS kickstart_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_chat_id INTEGER NOT NULL UNIQUE,
      current_step INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      initiated_by_user_id INTEGER NOT NULL,
      started_at INTEGER NOT NULL DEFAULT (unixepoch()),
      completed_at INTEGER,
      step_data TEXT
    );
  `);

  const db = drizzle(sqlite, { schema });
  return { db, schema, sqlite };
});

// Mock MCP manager
vi.mock("../agent/mcp-manager.js", () => ({
  mcpManager: {
    getAllTools: () => [],
    callTool: async () => "mock result",
  },
}));

import {
  getKickstartSession,
  createKickstartSession,
  advanceKickstartStep,
  completeKickstart,
  abandonKickstart,
} from "../db/queries.js";

const CHAT_ID = 12345;
const USER_ID = 67890;

describe("kickstart queries", () => {
  beforeEach(async () => {
    // Clean up between tests
    const { sqlite } = await import("../db/client.js");
    (sqlite as any).exec("DELETE FROM kickstart_sessions");
  });

  it("returns null when no active session exists", async () => {
    const session = await getKickstartSession(CHAT_ID);
    expect(session).toBeNull();
  });

  it("creates a new session at step 1", async () => {
    await createKickstartSession({
      telegramChatId: CHAT_ID,
      initiatedByUserId: USER_ID,
    });

    const session = await getKickstartSession(CHAT_ID);
    expect(session).not.toBeNull();
    expect(session!.currentStep).toBe(1);
    expect(session!.status).toBe("active");
    expect(session!.initiatedByUserId).toBe(USER_ID);
    expect(session!.stepData).toBeNull();
  });

  it("advances through steps and accumulates stepData", async () => {
    await createKickstartSession({
      telegramChatId: CHAT_ID,
      initiatedByUserId: USER_ID,
    });

    await advanceKickstartStep(CHAT_ID, "Linked workspace: xdeca");
    let session = await getKickstartSession(CHAT_ID);
    expect(session!.currentStep).toBe(2);
    const data1 = JSON.parse(session!.stepData!);
    expect(data1.step1).toBe("Linked workspace: xdeca");

    await advanceKickstartStep(CHAT_ID, "Default board: Sprint Board, list: To Do");
    session = await getKickstartSession(CHAT_ID);
    expect(session!.currentStep).toBe(3);
    const data2 = JSON.parse(session!.stepData!);
    expect(data2.step1).toBe("Linked workspace: xdeca");
    expect(data2.step2).toBe("Default board: Sprint Board, list: To Do");
  });

  it("completes a session", async () => {
    await createKickstartSession({
      telegramChatId: CHAT_ID,
      initiatedByUserId: USER_ID,
    });

    await completeKickstart(CHAT_ID);
    // getKickstartSession only finds active sessions
    const session = await getKickstartSession(CHAT_ID);
    expect(session).toBeNull();
  });

  it("abandons a session", async () => {
    await createKickstartSession({
      telegramChatId: CHAT_ID,
      initiatedByUserId: USER_ID,
    });

    await abandonKickstart(CHAT_ID);
    const session = await getKickstartSession(CHAT_ID);
    expect(session).toBeNull();
  });

  it("starting a new session replaces an existing active one", async () => {
    await createKickstartSession({
      telegramChatId: CHAT_ID,
      initiatedByUserId: USER_ID,
    });

    // Advance a couple steps
    await advanceKickstartStep(CHAT_ID, "Step 1 done");
    await advanceKickstartStep(CHAT_ID, "Step 2 done");

    // Start fresh
    await createKickstartSession({
      telegramChatId: CHAT_ID,
      initiatedByUserId: USER_ID,
    });

    const session = await getKickstartSession(CHAT_ID);
    expect(session!.currentStep).toBe(1);
    expect(session!.stepData).toBeNull();
  });

  it("advanceKickstartStep returns null for non-existent session", async () => {
    const result = await advanceKickstartStep(99999, "note");
    expect(result).toBeNull();
  });
});

describe("kickstart tool registration", () => {
  it("registers all kickstart tools", async () => {
    const { registerKickstartTools } = await import("./kickstart.js");
    const { getAnthropicTools } = await import("../agent/tool-registry.js");

    registerKickstartTools();
    const tools = getAnthropicTools();
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain("get_kickstart_state");
    expect(toolNames).toContain("start_kickstart");
    expect(toolNames).toContain("advance_kickstart");
    expect(toolNames).toContain("complete_kickstart");
    expect(toolNames).toContain("cancel_kickstart");
  });
});
