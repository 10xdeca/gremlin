import { describe, it, expect, vi } from "vitest";
import { storeSuggestion, getSuggestion, deleteSuggestion } from "./task-suggestion.js";

describe("task suggestion store", () => {
  const baseSuggestion = {
    title: "Fix the login page",
    workspacePublicId: "ws123",
    memberPublicIds: ["member1"],
    assigneeNames: ["@nick"],
    chatId: 123,
  };

  it("stores and retrieves a suggestion", () => {
    const id = storeSuggestion(baseSuggestion);
    const result = getSuggestion(id);

    expect(result).toBeDefined();
    expect(result!.title).toBe("Fix the login page");
    expect(result!.id).toBe(id);
    expect(result!.memberPublicIds).toEqual(["member1"]);
  });

  it("returns unique IDs for different suggestions", () => {
    const id1 = storeSuggestion(baseSuggestion);
    const id2 = storeSuggestion(baseSuggestion);

    expect(id1).not.toBe(id2);
  });

  it("returns undefined for non-existent ID", () => {
    expect(getSuggestion("nonexistent")).toBeUndefined();
  });

  it("deletes a suggestion", () => {
    const id = storeSuggestion(baseSuggestion);
    expect(getSuggestion(id)).toBeDefined();

    deleteSuggestion(id);
    expect(getSuggestion(id)).toBeUndefined();
  });

  it("expires suggestions after TTL", () => {
    vi.useFakeTimers();
    try {
      const id = storeSuggestion(baseSuggestion);
      expect(getSuggestion(id)).toBeDefined();

      // Advance past the 1-hour TTL
      vi.advanceTimersByTime(61 * 60 * 1000);
      expect(getSuggestion(id)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns suggestion within TTL", () => {
    vi.useFakeTimers();
    try {
      const id = storeSuggestion(baseSuggestion);

      // 30 minutes - still within TTL
      vi.advanceTimersByTime(30 * 60 * 1000);
      expect(getSuggestion(id)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
