import { describe, it, expect } from "vitest";
import { extractMentions } from "./mentions.js";

describe("extractMentions", () => {
  it("extracts single mention", () => {
    const result = extractMentions("Fix the bug @nick");
    expect(result.usernames).toEqual(["nick"]);
    expect(result.cleanText).toBe("Fix the bug");
  });

  it("extracts multiple mentions", () => {
    const result = extractMentions("Fix the login page @nick @alice");
    expect(result.usernames).toEqual(["nick", "alice"]);
    expect(result.cleanText).toBe("Fix the login page");
  });

  it("returns empty when no mentions", () => {
    const result = extractMentions("Fix the login page");
    expect(result.usernames).toEqual([]);
    expect(result.cleanText).toBe("Fix the login page");
  });

  it("filters out bot username", () => {
    const result = extractMentions("@mybot Fix the bug @nick", "mybot");
    expect(result.usernames).toEqual(["nick"]);
    expect(result.cleanText).toBe("Fix the bug");
  });

  it("filters bot username case-insensitively", () => {
    const result = extractMentions("@MyBot do something @alice", "mybot");
    expect(result.usernames).toEqual(["alice"]);
  });

  it("handles mentions at start of text", () => {
    const result = extractMentions("@nick fix the bug");
    expect(result.usernames).toEqual(["nick"]);
    expect(result.cleanText).toBe("fix the bug");
  });

  it("handles only mentions (no title text)", () => {
    const result = extractMentions("@nick @alice");
    expect(result.usernames).toEqual(["nick", "alice"]);
    expect(result.cleanText).toBe("");
  });

  it("does not match email-like patterns", () => {
    const result = extractMentions("send to user@example.com and @nick");
    expect(result.usernames).toEqual(["nick"]);
    expect(result.cleanText).toBe("send to user@example.com and");
  });

  it("collapses extra whitespace", () => {
    const result = extractMentions("Fix   the   bug   @nick");
    expect(result.usernames).toEqual(["nick"]);
    expect(result.cleanText).toBe("Fix the bug");
  });
});
