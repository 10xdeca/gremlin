import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockGenerateText = vi.fn();
const mockAlertAdmins = vi.fn();

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: (...args: unknown[]) => mockGenerateText(...args),
  };
});

vi.mock("../services/anthropic-client.js", () => ({
  getModel: vi.fn(() => "mock-model"),
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

// Mock tool-registry: returns a tools record
const mockGetTools = vi.fn(() => ({
  kan_search_cards: {
    description: "Search Kan cards",
    parameters: { type: "object", properties: { query: { type: "string" } } },
    execute: vi.fn(),
  },
}));
vi.mock("./tool-registry.js", () => ({
  getTools: (...args: unknown[]) => mockGetTools(...args),
}));

// Now import the module under test
import { runAgentLoop } from "./agent-loop.js";
import { getHistory, appendToHistory } from "./conversation-history.js";

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

/** Build a mock generateText result with text-only response. */
function textResult(text: string) {
  return {
    text,
    response: {
      messages: [{ role: "assistant", content: text }],
    },
    steps: [],
    finishReason: "stop",
    usage: { promptTokens: 10, completionTokens: 5 },
  };
}

/** Build a mock generateText result with tool calls and final text. */
function toolCallResult(finalText: string, toolCalls: Array<{ toolName: string; args: Record<string, unknown> }> = []) {
  return {
    text: finalText,
    response: {
      messages: [
        { role: "assistant", content: finalText },
      ],
    },
    steps: toolCalls.map((tc) => ({
      toolCalls: [{ toolName: tc.toolName, args: tc.args, toolCallId: "toolu_test" }],
      toolResults: [{ toolCallId: "toolu_test", result: "mock_result" }],
      text: "",
    })),
    finishReason: "stop",
    usage: { promptTokens: 20, completionTokens: 15 },
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
    mockGenerateText.mockResolvedValueOnce(textResult("Hello from Gremlin!"));

    const result = await runAgentLoop(fakeApi, input("Hi there"));

    expect(result).toBe("Hello from Gremlin!");
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(appendToHistory).toHaveBeenCalledOnce();
  });

  // ── 2. Tool calls are routed through the SDK ───────────────────────────

  it("passes tools to generateText and returns final text", async () => {
    mockGenerateText.mockResolvedValueOnce(
      toolCallResult("Found 1 overdue card: Fix login", [
        { toolName: "kan_search_cards", args: { query: "overdue" } },
      ]),
    );

    const result = await runAgentLoop(fakeApi, input("Show overdue tasks"));

    expect(result).toBe("Found 1 overdue card: Fix login");
    expect(mockGenerateText).toHaveBeenCalledTimes(1);

    // Verify tools were passed to generateText
    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.tools).toHaveProperty("kan_search_cards");
  });

  // ── 3. stopWhen is configured ────────────────────────────────────────

  it("sets stopWhen for tool loop control", async () => {
    mockGenerateText.mockResolvedValueOnce(textResult("Done"));

    await runAgentLoop(fakeApi, input("Do something"));

    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.stopWhen).toBeDefined();
  });

  // ── 4. Auth failure handling (401 from API) ────────────────────────────

  it("handles 401 auth errors from the API", async () => {
    const authError = new Error("Unauthorized") as Error & { status: number };
    authError.status = 401;
    mockGenerateText.mockRejectedValueOnce(authError);

    const result = await runAgentLoop(fakeApi, input("Hello"));

    expect(result).toContain("trouble with my brain connection");
    expect(mockAlertAdmins).toHaveBeenCalledWith(
      "token_auth",
      expect.stringContaining("API key rejected"),
    );
  });

  // ── 5. Max steps exhaustion returns fallback ───────────────────────────

  it("returns fallback when generateText returns empty text", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "",
      response: { messages: [] },
      steps: [],
      finishReason: "tool-calls",
    });

    const result = await runAgentLoop(fakeApi, input("Loop forever"));

    expect(result).toContain("too many steps");
  });

  // ── 6. System-initiated messages (no tools available) ──────────────────

  it("skips tools for system-initiated messages", async () => {
    mockGenerateText.mockResolvedValueOnce(
      textResult("Reminder: you have overdue tasks!"),
    );

    const result = await runAgentLoop(
      fakeApi,
      input("Scheduled reminder", { isSystemInitiated: true, userId: 0 }),
    );

    expect(result).toBe("Reminder: you have overdue tasks!");

    // Verify empty tools object was passed
    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.tools).toEqual({});
  });

  // ── 7. Image attachment handling ───────────────────────────────────────

  it("passes images to generateText and strips them from history", async () => {
    mockGenerateText.mockResolvedValueOnce(
      textResult("I see a screenshot of a login page."),
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

    // Verify image was included in the messages passed to generateText
    const callArgs = mockGenerateText.mock.calls[0][0];
    const msgs = callArgs.messages;
    const userMsg = msgs[msgs.length - 1];
    expect(Array.isArray(userMsg.content)).toBe(true);
    const imageBlock = userMsg.content.find((b: any) => b.type === "image");
    expect(imageBlock).toBeDefined();

    // Verify images are stripped from the history that was appended
    const appendCall = (appendToHistory as any).mock.calls[0];
    const storedMessages = appendCall[1];
    const storedUserMsg = storedMessages.find((m: any) => m.role === "user");
    if (typeof storedUserMsg.content === "string") {
      expect(storedUserMsg.content).not.toContain("iVBORw0KGgo");
    } else {
      const hasImage = storedUserMsg.content.some((b: any) => b.type === "image");
      expect(hasImage).toBe(false);
    }
  });

  // ── 8. Conversation history is included ────────────────────────────────

  it("includes conversation history from getHistory()", async () => {
    (getHistory as any).mockReturnValueOnce([
      { role: "user", content: "Previous question" },
      { role: "assistant", content: "Previous answer" },
    ]);

    mockGenerateText.mockResolvedValueOnce(textResult("Follow-up answer"));

    await runAgentLoop(fakeApi, input("Follow-up question"));

    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.messages).toHaveLength(3); // 2 history + 1 new
    expect(callArgs.messages[0].content).toBe("Previous question");
    expect(callArgs.messages[1].content).toBe("Previous answer");
    expect(callArgs.messages[2].content).toBe("Follow-up question");
  });

  // ── 9. Typing indicators are sent ──────────────────────────────────────

  it("sends typing indicators during processing", async () => {
    mockGenerateText.mockResolvedValueOnce(textResult("Done"));

    await runAgentLoop(fakeApi, input("Do something"));

    // At least 1 typing indicator (initial)
    expect(fakeApi.sendChatAction).toHaveBeenCalled();
    expect(fakeApi.sendChatAction.mock.calls[0][1]).toBe("typing");
  });

  // ── 10. Non-auth API errors propagate ──────────────────────────────────

  it("throws non-auth API errors (e.g. 500) to be caught by caller", async () => {
    const serverError = new Error("Internal Server Error") as Error & { status: number };
    serverError.status = 500;
    mockGenerateText.mockRejectedValueOnce(serverError);

    await expect(
      runAgentLoop(fakeApi, input("Hello")),
    ).rejects.toThrow("Internal Server Error");
  });

  // ── 11. System prompt is passed ────────────────────────────────────────

  it("passes system prompt to generateText", async () => {
    mockGenerateText.mockResolvedValueOnce(textResult("OK"));

    await runAgentLoop(fakeApi, input("Hello"));

    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.system).toBe("You are Gremlin, a test bot.");
  });
});
