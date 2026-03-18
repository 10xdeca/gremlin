import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
}));

// Mock the anthropic client
vi.mock("../services/anthropic-client.js", () => ({
  getAnthropicClient: async () => ({
    messages: { create: mockCreate },
  }),
  invalidateCachedClient: () => {},
  getTokenHealth: () => ({ status: "healthy", lastRefresh: Date.now(), expiresAt: Date.now() + 3600000 }),
}));

// Mock MCP manager (still needed for module resolution)
vi.mock("../agent/mcp-manager.js", () => ({
  mcpManager: {
    getAllTools: () => [],
    getToolsForServer: () => [],
    callTool: async () => "mock",
    init: async () => {},
    shutdown: async () => {},
    getClient: () => null,
    getServerNames: () => [],
    healthCheck: async () => [],
    restartServer: async () => ({ success: true, message: "mock" }),
  },
}));

import {
  scanImageForContacts,
  formatConfirmation,
  getActiveScanCount,
  _resetActiveScanCount,
  type ScanContext,
  type SendConfirmation,
} from "./contact-scanner.js";

const FAKE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const SCAN_CTX: ScanContext = { chatId: 12345, messageThreadId: 99 };

describe("contact-scanner", () => {
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetActiveScanCount();
    mockSend = vi.fn();
  });

  afterEach(() => {
    _resetActiveScanCount();
  });

  describe("classification", () => {
    it("returns early for non-contact images", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: '{"hasContacts": false}' }],
      });

      await scanImageForContacts(FAKE_BASE64, "image/jpeg", SCAN_CTX, mockSend);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("sends confirmation when contacts are found", async () => {
      const contacts = [
        { name: "Jane Doe", email: "jane@example.com", organization: "Acme Corp" },
      ];

      mockCreate.mockResolvedValueOnce({
        content: [
          { type: "text", text: JSON.stringify({ hasContacts: true, contacts }) },
        ],
      });

      await scanImageForContacts(FAKE_BASE64, "image/jpeg", SCAN_CTX, mockSend);

      // Only 1 API call (classification only — no tool-calling step)
      expect(mockCreate).toHaveBeenCalledTimes(1);
      // Confirmation sent
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(
        SCAN_CTX,
        expect.stringContaining("Jane Doe"),
      );
    });

    it("handles malformed classification JSON gracefully", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "not valid json" }],
      });

      await scanImageForContacts(FAKE_BASE64, "image/png", SCAN_CTX, mockSend);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("returns early when contacts array is empty", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: "text", text: '{"hasContacts": true, "contacts": []}' },
        ],
      });

      await scanImageForContacts(FAKE_BASE64, "image/jpeg", SCAN_CTX, mockSend);

      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe("formatConfirmation", () => {
    it("formats a single contact", () => {
      const msg = formatConfirmation([
        { name: "Bob Smith", email: "bob@test.com", organization: "TestCo" },
      ]);

      expect(msg).toContain("1 potential contact");
      expect(msg).toContain("*Bob Smith*");
      expect(msg).toContain("bob@test.com");
      expect(msg).toContain("TestCo");
      expect(msg).toContain("Want me to save this to contacts?");
    });

    it("formats multiple contacts", () => {
      const msg = formatConfirmation([
        { name: "Alice", email: "alice@test.com" },
        { name: "Bob", phone: "+1234567890" },
      ]);

      expect(msg).toContain("2 potential contacts");
      expect(msg).toContain("*Alice*");
      expect(msg).toContain("*Bob*");
      expect(msg).toContain("Want me to save them to contacts?");
    });

    it("handles contacts with only a name", () => {
      const msg = formatConfirmation([{ name: "Charlie" }]);
      expect(msg).toContain("*Charlie*");
    });

    it("includes title when present", () => {
      const msg = formatConfirmation([
        { name: "Dr. Eve", title: "CTO", organization: "Startup Inc" },
      ]);
      expect(msg).toContain("CTO");
      expect(msg).toContain("Startup Inc");
    });
  });

  describe("concurrency limiter", () => {
    it("drops scans when at capacity", async () => {
      let resolveFirst!: () => void;
      let resolveSecond!: () => void;
      const firstScan = new Promise<void>((r) => { resolveFirst = r; });
      const secondScan = new Promise<void>((r) => { resolveSecond = r; });

      let callCount = 0;
      mockCreate.mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          await (callCount === 1 ? firstScan : secondScan);
        }
        return { content: [{ type: "text", text: '{"hasContacts": false}' }] };
      });

      // Start 2 scans (fills capacity)
      const scan1 = scanImageForContacts(FAKE_BASE64, "image/jpeg", SCAN_CTX, mockSend);
      const scan2 = scanImageForContacts(FAKE_BASE64, "image/jpeg", SCAN_CTX, mockSend);

      // Wait a tick for the scans to start
      await new Promise((r) => setTimeout(r, 10));

      // This should be dropped
      await scanImageForContacts(FAKE_BASE64, "image/jpeg", SCAN_CTX, mockSend);

      // Release the blocked scans
      resolveFirst();
      resolveSecond();
      await scan1;
      await scan2;

      // Only 2 classification calls (third was dropped)
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });
  });

  describe("error handling", () => {
    it("catches and logs errors without throwing", async () => {
      mockCreate.mockRejectedValueOnce(new Error("API down"));

      await expect(
        scanImageForContacts(FAKE_BASE64, "image/jpeg", SCAN_CTX, mockSend),
      ).resolves.toBeUndefined();

      expect(getActiveScanCount()).toBe(0);
    });

    it("catches sendConfirmation errors without throwing", async () => {
      const contacts = [{ name: "Test User", email: "test@test.com" }];

      mockCreate.mockResolvedValueOnce({
        content: [
          { type: "text", text: JSON.stringify({ hasContacts: true, contacts }) },
        ],
      });

      const failingSend: SendConfirmation = async () => {
        throw new Error("Telegram API down");
      };

      await expect(
        scanImageForContacts(FAKE_BASE64, "image/jpeg", SCAN_CTX, failingSend),
      ).resolves.toBeUndefined();

      expect(getActiveScanCount()).toBe(0);
    });
  });
});
