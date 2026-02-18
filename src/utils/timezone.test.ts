import { describe, it, expect } from "vitest";
import {
  getTodayInTimezone,
  getCurrentHourInTimezone,
  isWeekendInTimezone,
} from "./timezone.js";

describe("timezone utilities", () => {
  describe("getTodayInTimezone", () => {
    it("returns YYYY-MM-DD format", () => {
      const result = getTodayInTimezone("UTC", new Date("2026-02-18T12:00:00Z"));
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("returns the correct date in UTC", () => {
      const result = getTodayInTimezone("UTC", new Date("2026-02-18T12:00:00Z"));
      expect(result).toBe("2026-02-18");
    });

    it("handles timezone offset — Sydney is UTC+11 in Feb", () => {
      // 2026-02-18T20:00:00Z → Feb 19 7am in Sydney (AEDT = UTC+11)
      const result = getTodayInTimezone("Australia/Sydney", new Date("2026-02-18T20:00:00Z"));
      expect(result).toBe("2026-02-19");
    });

    it("handles timezone offset — LA is UTC-8 in Feb", () => {
      // 2026-02-18T03:00:00Z → Feb 17 7pm in LA (PST = UTC-8)
      const result = getTodayInTimezone("America/Los_Angeles", new Date("2026-02-18T03:00:00Z"));
      expect(result).toBe("2026-02-17");
    });
  });

  describe("getCurrentHourInTimezone", () => {
    it("returns hour 0-23", () => {
      const result = getCurrentHourInTimezone("UTC", new Date("2026-02-18T14:30:00Z"));
      expect(result).toBe(14);
    });

    it("returns 0 for midnight UTC", () => {
      const result = getCurrentHourInTimezone("UTC", new Date("2026-02-18T00:30:00Z"));
      expect(result).toBe(0);
    });

    it("handles timezone offset for Sydney", () => {
      // 2026-02-18T22:00:00Z → Feb 19 9am AEDT (UTC+11)
      const result = getCurrentHourInTimezone("Australia/Sydney", new Date("2026-02-18T22:00:00Z"));
      expect(result).toBe(9);
    });

    it("handles timezone offset for LA", () => {
      // 2026-02-18T17:00:00Z → Feb 18 9am PST (UTC-8)
      const result = getCurrentHourInTimezone("America/Los_Angeles", new Date("2026-02-18T17:00:00Z"));
      expect(result).toBe(9);
    });
  });

  describe("isWeekendInTimezone", () => {
    it("returns true for Saturday", () => {
      // 2026-02-21 is a Saturday
      expect(isWeekendInTimezone("UTC", new Date("2026-02-21T12:00:00Z"))).toBe(true);
    });

    it("returns true for Sunday", () => {
      // 2026-02-22 is a Sunday
      expect(isWeekendInTimezone("UTC", new Date("2026-02-22T12:00:00Z"))).toBe(true);
    });

    it("returns false for Wednesday", () => {
      // 2026-02-18 is a Wednesday
      expect(isWeekendInTimezone("UTC", new Date("2026-02-18T12:00:00Z"))).toBe(false);
    });

    it("respects timezone — late Friday UTC can be Saturday in Sydney", () => {
      // 2026-02-20 (Friday) 20:00 UTC → Feb 21 (Saturday) 7am in Sydney
      expect(isWeekendInTimezone("Australia/Sydney", new Date("2026-02-20T20:00:00Z"))).toBe(true);
      // Same instant is still Friday in UTC
      expect(isWeekendInTimezone("UTC", new Date("2026-02-20T20:00:00Z"))).toBe(false);
    });
  });
});
