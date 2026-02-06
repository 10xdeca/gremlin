import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatDueDate, escapeMarkdown, formatCardList } from "./format.js";

describe("escapeMarkdown", () => {
  it("escapes special markdown characters", () => {
    expect(escapeMarkdown("hello_world")).toBe("hello\\_world");
    expect(escapeMarkdown("*bold*")).toBe("\\*bold\\*");
    expect(escapeMarkdown("[link](url)")).toBe("\\[link\\]\\(url\\)");
  });

  it("returns empty string unchanged", () => {
    expect(escapeMarkdown("")).toBe("");
  });

  it("leaves plain text unchanged", () => {
    expect(escapeMarkdown("hello world")).toBe("hello world");
  });
});

describe("formatDueDate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Use midnight UTC to avoid off-by-one issues with date-only strings
    vi.setSystemTime(new Date("2025-06-15T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'No due date' for null", () => {
    expect(formatDueDate(null)).toBe("No due date");
  });

  it("shows '(today)' for today's date", () => {
    const result = formatDueDate("2025-06-15");
    expect(result).toContain("(today)");
  });

  it("shows '(tomorrow)' for tomorrow's date", () => {
    const result = formatDueDate("2025-06-16");
    expect(result).toContain("(tomorrow)");
  });

  it("shows overdue days for past dates", () => {
    const result = formatDueDate("2025-06-12");
    expect(result).toContain("overdue");
    expect(result).toContain("3 days");
  });

  it("shows 'in X days' for near future dates", () => {
    const result = formatDueDate("2025-06-20");
    expect(result).toContain("in 5 days");
  });

  it("shows singular 'day' for 1 day overdue", () => {
    const result = formatDueDate("2025-06-14");
    expect(result).toContain("1 day overdue");
  });
});

describe("formatCardList", () => {
  it("returns 'No tasks found.' for empty list", () => {
    expect(formatCardList([])).toBe("No tasks found.");
  });

  it("formats cards with numbering", () => {
    const cards = [
      {
        card: {
          publicId: "abc123",
          title: "Test Task",
          dueDate: null,
          members: [],
        } as any,
        board: { name: "Board 1", slug: "board-1" } as any,
        list: { name: "To Do" } as any,
      },
    ];
    const result = formatCardList(cards);
    expect(result).toContain("1.");
    expect(result).toContain("Test Task");
    expect(result).toContain("abc123");
    expect(result).toContain("To Do");
  });
});
