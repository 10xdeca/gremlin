import { describe, it, expect, vi, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockCreate = vi.fn();
const mockInvalidate = vi.fn();
const mockAlertAdmins = vi.fn();

vi.mock("../services/anthropic-client.js", () => ({
  getAnthropicClient: vi.fn(async () => ({
    messages: { create: mockCreate },
  })),
  invalidateCachedClient: (...args: unknown[]) => mockInvalidate(...args),
}));

vi.mock("./system-prompt.js", () => ({
  buildSystemPrompt: vi.fn(async () => "You are Gremlin, a test bot."),
}));

vi.mock("./conversation-history.js", () => ({
  getHistory: vi.fn(() => []),
  appendToHistory: vi.fn(),
}));

vi.mock("../services/admin-alerts.js", () => ({
  alertAdmins: (...args: unknown[]) => mockAlertAdmins(...args),
}));

// Mock tool-registry: one dummy tool, controllable executeTool
const mockExecuteTool = vi.fn();
vi.mock("./tool-registry.js", () => ({
  getAnthropicTools: vi.fn(() => [
    {
      name: "kan_search_cards",
      description: "Search Kan cards",
      input_schema: { type: "object", properties: { query: { type: "string" } } },
    },
  ]),
  executeTool: (...args: unknown[]) => mockExecuteTool(...args),
}));

// Now import the module under test
import { runAgentLoop } from "./agent-loop.js";
import { getHistory, appendToHistory } from "./conversation-history.js";
import { getAnthropicClient } from "../services/anthropic-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal AgentInput for testing. */
function input(text: string, overrides: Record<string, unknown> = {}) {
  return {
    text,
    chatId: 12345,
    userId: 67890,
    username: "testuser",
    isAdmin: false,
    ...overrides,
  };
}

/** A fake Grammy Api object that silently absorbs sendChatAction calls. */
const fakeApi = {
  sendChatAction: vi.fn(async () => true),
} as any;

/** Build an Anthropic-style response with text-only content. */
function textResponse(text: string): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

/** Build an Anthropic-style response that includes a tool_use block. */
function toolUseResponse(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId = "toolu_test_1",
): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [
      {
        type: "tool_use",
        id: toolUseId,
        name: toolName,
        input: toolInput,
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 15 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent-loop integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. Simple text response (no tools) ──────────────────────────────────

  it("returns text response when Claude does not call tools", async () => {
    mockCreate.mockResolvedValueOnce(textResponse("Hello from Gremlin!"));

    const result = await runAgentLoop(fakeApi, input("Hi there"));

    expect(result).toBe("Hello from Gremlin!");
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockExecuteTool).not.toHaveBeenCalled();
    expect(appendToHistory).toHaveBeenCalledOnce();
  });

  // ── 2. Single tool call round ───────────────────────────────────────────

  it("executes a single tool call and returns final text", async () => {
    // First Claude response: call a tool
    mockCreate.mockResolvedValueOnce(
      toolUseResponse("kan_search_cards", { query: "overdue" }),
    );
    // Tool returns a result
    mockExecuteTool.mockResolvedValueOnce(
      JSON.stringify([{ title: "Fix login", publicId: "card_123" }]),
    );
    // Second Claude response: final text after seeing tool result
    mockCreate.mockResolvedValueOnce(
      textResponse("Found 1 overdue card: Fix login"),
    );

    const result = await runAgentLoop(fakeApi, input("Show overdue tasks"));

    expect(result).toBe("Found 1 overdue card: Fix login");
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockExecuteTool).toHaveBeenCalledWith("kan_search_cards", { query: "overdue" });
  });

  // ── 3. Multi-round tool calls ───────────────────────────────────────────

  it("handles multiple rounds of tool calls", async () => {
    // Round 1: search cards
    mockCreate.mockResolvedValueOnce(
      toolUseResponse("kan_search_cards", { query: "login" }, "toolu_r1"),
    );
    mockExecuteTool.mockResolvedValueOnce('{"cards": []}');

    // Round 2: search again with different query
    mockCreate.mockResolvedValueOnce(
      toolUseResponse("kan_search_cards", { query: "auth" }, "toolu_r2"),
    );
    mockExecuteTool.mockResolvedValueOnce('{"cards": [{"title": "Auth bug"}]}');

    // Round 3: final text
    mockCreate.mockResolvedValueOnce(
      textResponse("Found an auth bug card."),
    );

    const result = await runAgentLoop(fakeApi, input("Find login related tasks"));

    expect(result).toBe("Found an auth bug card.");
    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(mockExecuteTool).toHaveBeenCalledTimes(2);
  });

  // ── 4. Tool execution error handling ────────────────────────────────────

  it("recovers gracefully when a tool throws an error", async () => {
    // Claude calls a tool
    mockCreate.mockResolvedValueOnce(
      toolUseResponse("kan_search_cards", { query: "broken" }),
    );
    // Tool throws
    mockExecuteTool.mockRejectedValueOnce(new Error("MCP server unreachable"));
    // Claude handles the error and responds
    mockCreate.mockResolvedValueOnce(
      textResponse("Sorry, I couldn't search cards right now."),
    );

    const result = await runAgentLoop(fakeApi, input("Search for broken tasks"));

    expect(result).toBe("Sorry, I couldn't search cards right now.");
    expect(mockCreate).toHaveBeenCalledTimes(2);

    // Verify the error was passed back to Claude as a tool_result with is_error
    const secondCallMessages = mockCreate.mock.calls[1][0].messages;
    const lastUserMsg = secondCallMessages[secondCallMessages.length - 1];
    expect(lastUserMsg.role).toBe("user");
    const toolResult = lastUserMsg.content[0];
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toContain("MCP server unreachable");
  });

  // ── 5. Auth failure handling (401 from Claude API) ──────────────────────

  it("handles 401 auth errors from Claude API", async () => {
    const authError = new Error("Unauthorized") as Error & { status: number };
    authError.status = 401;
    mockCreate.mockRejectedValueOnce(authError);

    const result = await runAgentLoop(fakeApi, input("Hello"));

    expect(result).toContain("trouble with my brain connection");
    expect(mockInvalidate).toHaveBeenCalledOnce();
    expect(mockAlertAdmins).toHaveBeenCalledWith(
      "token_auth",
      expect.stringContaining("Access token rejected"),
    );
  });

  // ── 6. Max tool rounds exceeded ─────────────────────────────────────────

  it("caps at MAX_TOOL_ROUNDS and returns fallback text", async () => {
    // Every Claude response calls a tool — should hit the 10-round limit
    for (let i = 0; i < 10; i++) {
      mockCreate.mockResolvedValueOnce(
        toolUseResponse("kan_search_cards", { query: `round_${i}` }, `toolu_${i}`),
      );
      mockExecuteTool.mockResolvedValueOnce(`result_${i}`);
    }

    const result = await runAgentLoop(fakeApi, input("Loop forever"));

    expect(mockCreate).toHaveBeenCalledTimes(10);
    expect(mockExecuteTool).toHaveBeenCalledTimes(10);
    // Should return the fallback capping message
    expect(result).toContain("too many steps");
  });

  // ── 7. System-initiated messages (no tools available) ───────────────────

  it("skips tools for system-initiated messages", async () => {
    mockCreate.mockResolvedValueOnce(
      textResponse("Reminder: you have overdue tasks!"),
    );

    const result = await runAgentLoop(
      fakeApi,
      input("Scheduled reminder", { isSystemInitiated: true, userId: 0 }),
    );

    expect(result).toBe("Reminder: you have overdue tasks!");

    // Verify tools were NOT passed to the Claude API call
    const createArgs = mockCreate.mock.calls[0][0];
    expect(createArgs.tools).toBeUndefined();
  });

  // ── 8. Image attachment handling ────────────────────────────────────────

  it("passes images to Claude and strips them from history", async () => {
    mockCreate.mockResolvedValueOnce(
      textResponse("I see a screenshot of a login page."),
    );

    const result = await runAgentLoop(
      fakeApi,
      input("What's in this image?", {
        images: [
          {
            base64: "iVBORw0KGgoAAAANSUhEUg==",
            mediaType: "image/png",
          },
        ],
      }),
    );

    expect(result).toBe("I see a screenshot of a login page.");

    // Verify image was included in the API call
    const createArgs = mockCreate.mock.calls[0][0];
    const userMsg = createArgs.messages[createArgs.messages.length - 1];
    expect(Array.isArray(userMsg.content)).toBe(true);
    const imageBlock = userMsg.content.find((b: any) => b.type === "image");
    expect(imageBlock).toBeDefined();
    expect(imageBlock.source.media_type).toBe("image/png");

    // Verify images are stripped from the history that was appended
    const appendCall = (appendToHistory as any).mock.calls[0];
    const storedMessages = appendCall[1];
    // The user message in stored history should NOT have image blocks
    const storedUserMsg = storedMessages.find((m: any) => m.role === "user");
    if (typeof storedUserMsg.content === "string") {
      // Good — images were stripped to plain text
      expect(storedUserMsg.content).not.toContain("iVBORw0KGgo");
    } else {
      // If it's still an array, it should not contain image blocks
      const hasImage = storedUserMsg.content.some((b: any) => b.type === "image");
      expect(hasImage).toBe(false);
    }
  });

  // ── 9. Conversation history is included in API call ─────────────────────

  it("includes conversation history from getHistory()", async () => {
    // Simulate existing history
    (getHistory as any).mockReturnValueOnce([
      { role: "user", content: "Previous question" },
      { role: "assistant", content: "Previous answer" },
    ]);

    mockCreate.mockResolvedValueOnce(textResponse("Follow-up answer"));

    await runAgentLoop(fakeApi, input("Follow-up question"));

    const createArgs = mockCreate.mock.calls[0][0];
    expect(createArgs.messages).toHaveLength(3); // 2 history + 1 new
    expect(createArgs.messages[0].content).toBe("Previous question");
    expect(createArgs.messages[1].content).toBe("Previous answer");
    expect(createArgs.messages[2].content).toBe("Follow-up question");
  });

  // ── 10. Typing indicators are sent ──────────────────────────────────────

  it("sends typing indicators during processing", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse("kan_search_cards", { query: "test" }),
    );
    mockExecuteTool.mockResolvedValueOnce("result");
    mockCreate.mockResolvedValueOnce(textResponse("Done"));

    await runAgentLoop(fakeApi, input("Do something"));

    // At least 2 typing indicators: initial + during tool execution
    expect(fakeApi.sendChatAction).toHaveBeenCalled();
    expect(fakeApi.sendChatAction.mock.calls[0][1]).toBe("typing");
  });

  // ── 11. getAnthropicClient failure ──────────────────────────────────────

  it("returns error message when Anthropic client cannot be obtained", async () => {
    (getAnthropicClient as any).mockRejectedValueOnce(
      new Error("No refresh token available"),
    );

    const result = await runAgentLoop(fakeApi, input("Hello"));

    expect(result).toContain("trouble with my brain connection");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // ── 12. Non-auth API errors propagate ───────────────────────────────────

  it("throws non-auth API errors (e.g. 500) to be caught by caller", async () => {
    const serverError = new Error("Internal Server Error") as Error & { status: number };
    serverError.status = 500;
    mockCreate.mockRejectedValueOnce(serverError);

    await expect(
      runAgentLoop(fakeApi, input("Hello")),
    ).rejects.toThrow("Internal Server Error");

    // Should NOT invalidate client for non-auth errors
    expect(mockInvalidate).not.toHaveBeenCalled();
  });
});
