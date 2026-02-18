import { describe, it, expect } from "vitest";
import { formatStandupSummary, type StandupSummaryInput } from "./standup-summarizer.js";

describe("formatStandupSummary", () => {
  it("formats a complete summary with responses and missing users", () => {
    const input: StandupSummaryInput = {
      date: "2026-02-18",
      responses: [
        {
          telegramUserId: 100,
          telegramUsername: "alice",
          yesterday: "Finished auth module",
          today: "Starting API tests",
          blockers: null,
        },
        {
          telegramUserId: 200,
          telegramUsername: "bob",
          yesterday: "Code review",
          today: "Deploy pipeline",
          blockers: "Waiting on staging access",
        },
      ],
      expectedUsernames: ["alice", "bob", "charlie"],
    };

    const result = formatStandupSummary(input);

    // Header with count
    expect(result).toContain("2/3 responded");
    // Alice's update
    expect(result).toContain("@alice");
    expect(result).toContain("Finished auth module");
    expect(result).toContain("Starting API tests");
    // Bob's update with blocker
    expect(result).toContain("@bob");
    expect(result).toContain("Waiting on staging access");
    // Missing user
    expect(result).toContain("@charlie");
    expect(result).toContain("Missing");
  });

  it("handles no responses", () => {
    const input: StandupSummaryInput = {
      date: "2026-02-18",
      responses: [],
      expectedUsernames: ["alice", "bob"],
    };

    const result = formatStandupSummary(input);

    expect(result).toContain("0/2 responded");
    expect(result).toContain("@alice");
    expect(result).toContain("@bob");
  });

  it("handles all users responded (no missing section)", () => {
    const input: StandupSummaryInput = {
      date: "2026-02-18",
      responses: [
        {
          telegramUserId: 100,
          telegramUsername: "alice",
          yesterday: "Stuff",
          today: "More stuff",
          blockers: null,
        },
      ],
      expectedUsernames: ["alice"],
    };

    const result = formatStandupSummary(input);

    expect(result).toContain("1/1 responded");
    expect(result).not.toContain("Missing");
  });

  it("handles response with no parsed details", () => {
    const input: StandupSummaryInput = {
      date: "2026-02-18",
      responses: [
        {
          telegramUserId: 100,
          telegramUsername: "alice",
          yesterday: null,
          today: null,
          blockers: null,
        },
      ],
      expectedUsernames: ["alice"],
    };

    const result = formatStandupSummary(input);
    expect(result).toContain("No details parsed");
  });

  it("handles user without username (falls back to user ID)", () => {
    const input: StandupSummaryInput = {
      date: "2026-02-18",
      responses: [
        {
          telegramUserId: 999,
          telegramUsername: null,
          yesterday: "Did things",
          today: null,
          blockers: null,
        },
      ],
      expectedUsernames: [],
    };

    const result = formatStandupSummary(input);
    expect(result).toContain("User 999");
  });

  it("is case-insensitive when matching responded vs expected", () => {
    const input: StandupSummaryInput = {
      date: "2026-02-18",
      responses: [
        {
          telegramUserId: 100,
          telegramUsername: "Alice",
          yesterday: "Work",
          today: null,
          blockers: null,
        },
      ],
      expectedUsernames: ["alice"],
    };

    const result = formatStandupSummary(input);
    // alice should NOT be in the missing list since Alice responded
    expect(result).not.toContain("Missing");
  });
});
