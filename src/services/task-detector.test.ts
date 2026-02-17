import { describe, it, expect, vi, beforeEach } from "vitest";
import { shouldCheckMessage, recordCooldown, isBotMention } from "./task-detector.js";

describe("shouldCheckMessage", () => {
  beforeEach(() => {
    // Reset cooldowns by advancing time past the cooldown window
    vi.useFakeTimers();
    vi.advanceTimersByTime(10 * 60 * 1000);
    vi.useRealTimers();
  });

  it("returns true for normal messages", () => {
    expect(shouldCheckMessage(123, "I think we should update the CI pipeline", false)).toBe(true);
  });

  it("skips bot messages", () => {
    expect(shouldCheckMessage(123, "I think we should update the CI pipeline", true)).toBe(false);
  });

  it("skips command messages", () => {
    expect(shouldCheckMessage(123, "/newtask Fix the login page", false)).toBe(false);
  });

  it("skips short messages (< 20 chars)", () => {
    expect(shouldCheckMessage(123, "ok sounds good", false)).toBe(false);
  });

  it("accepts messages exactly 20 chars", () => {
    expect(shouldCheckMessage(123, "12345678901234567890", false)).toBe(true);
  });

  it("respects per-chat cooldown", () => {
    vi.useFakeTimers();
    try {
      const chatId = 999;

      // First message should pass
      expect(shouldCheckMessage(chatId, "I think we should do something about this", false)).toBe(true);
      recordCooldown(chatId);

      // Second message within cooldown should be blocked
      vi.advanceTimersByTime(60 * 1000); // 1 minute
      expect(shouldCheckMessage(chatId, "We also need to update the docs for the project", false)).toBe(false);

      // After cooldown expires, should pass again
      vi.advanceTimersByTime(5 * 60 * 1000); // 5 more minutes
      expect(shouldCheckMessage(chatId, "Someone should look into the memory issue here", false)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cooldowns are per-chat", () => {
    vi.useFakeTimers();
    try {
      recordCooldown(100);

      // Different chat should not be affected
      expect(shouldCheckMessage(200, "I think we should update the documentation", false)).toBe(true);

      // Same chat should be affected
      expect(shouldCheckMessage(100, "We need to fix the deployment pipeline", false)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("isBotMention", () => {
  it("detects @botname mention", () => {
    expect(isBotMention("@gremlin create a task to fix login", "gremlin")).toBe(true);
  });

  it("detects mention at end of message", () => {
    expect(isBotMention("hey @gremlin", "gremlin")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isBotMention("@Gremlin fix the login page", "gremlin")).toBe(true);
    expect(isBotMention("@GREMLIN fix the login page", "gremlin")).toBe(true);
  });

  it("returns false when bot username is not mentioned", () => {
    expect(isBotMention("@nick fix the login page", "gremlin")).toBe(false);
  });

  it("returns false for no bot username provided", () => {
    expect(isBotMention("@gremlin create a task", undefined)).toBe(false);
  });

  it("does not match email-style mentions", () => {
    expect(isBotMention("email gremlin@example.com about this", "gremlin")).toBe(false);
  });

  it("matches mention in the middle of a message", () => {
    expect(isBotMention("hey @gremlin please create a task", "gremlin")).toBe(true);
  });
});
