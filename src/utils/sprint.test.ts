import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getSprintDay,
  isSprintPlanningWindow,
  isMidSprintDay,
  isSprintEndDay,
  isBreakDay,
  getSprintInfo,
} from "./sprint.js";

describe("sprint utilities", () => {
  // Sprint epoch defaults to Jan 5, 2025 (a Sunday)
  // Sprint length is 14 days (13 sprint + 1 break)

  describe("getSprintDay", () => {
    it("returns 1 on sprint start day (Sunday)", () => {
      // Jan 5, 2025 is the epoch = day 1
      expect(getSprintDay(new Date("2025-01-05T12:00:00Z"))).toBe(1);
    });

    it("returns 2 on Monday of sprint start", () => {
      expect(getSprintDay(new Date("2025-01-06T12:00:00Z"))).toBe(2);
    });

    it("returns 7 on Saturday", () => {
      expect(getSprintDay(new Date("2025-01-11T12:00:00Z"))).toBe(7);
    });

    it("returns 13 on sprint end Friday", () => {
      expect(getSprintDay(new Date("2025-01-17T12:00:00Z"))).toBe(13);
    });

    it("returns 14 on break day Saturday", () => {
      expect(getSprintDay(new Date("2025-01-18T12:00:00Z"))).toBe(14);
    });

    it("cycles correctly for the next sprint", () => {
      // Jan 19, 2025 should be day 1 of the next sprint
      expect(getSprintDay(new Date("2025-01-19T12:00:00Z"))).toBe(1);
    });

    it("returns a value between 1 and 14", () => {
      // Test a range of dates
      for (let i = 0; i < 100; i++) {
        const date = new Date("2025-01-05T12:00:00Z");
        date.setDate(date.getDate() + i);
        const day = getSprintDay(date);
        expect(day).toBeGreaterThanOrEqual(1);
        expect(day).toBeLessThanOrEqual(14);
      }
    });
  });

  describe("isSprintPlanningWindow", () => {
    it("returns true on day 1 (Sunday)", () => {
      expect(isSprintPlanningWindow(new Date("2025-01-05T12:00:00Z"))).toBe(true);
    });

    it("returns true on day 2 (Monday)", () => {
      expect(isSprintPlanningWindow(new Date("2025-01-06T12:00:00Z"))).toBe(true);
    });

    it("returns false on day 3 (Tuesday)", () => {
      expect(isSprintPlanningWindow(new Date("2025-01-07T12:00:00Z"))).toBe(false);
    });
  });

  describe("isMidSprintDay", () => {
    it("returns true on day 8 (Sunday)", () => {
      expect(isMidSprintDay(new Date("2025-01-12T12:00:00Z"))).toBe(true);
    });

    it("returns false on other days", () => {
      expect(isMidSprintDay(new Date("2025-01-11T12:00:00Z"))).toBe(false);
    });
  });

  describe("isSprintEndDay", () => {
    it("returns true on day 13 (Friday)", () => {
      expect(isSprintEndDay(new Date("2025-01-17T12:00:00Z"))).toBe(true);
    });

    it("returns false on other days", () => {
      expect(isSprintEndDay(new Date("2025-01-16T12:00:00Z"))).toBe(false);
    });
  });

  describe("isBreakDay", () => {
    it("returns true on day 14 (Saturday)", () => {
      expect(isBreakDay(new Date("2025-01-18T12:00:00Z"))).toBe(true);
    });

    it("returns false on other days", () => {
      expect(isBreakDay(new Date("2025-01-17T12:00:00Z"))).toBe(false);
    });
  });

  describe("getSprintInfo", () => {
    it("returns correct info for planning window", () => {
      const info = getSprintInfo(new Date("2025-01-05T12:00:00Z"));
      expect(info.day).toBe(1);
      expect(info.isPlanningWindow).toBe(true);
      expect(info.isMidSprint).toBe(false);
      expect(info.isSprintEnd).toBe(false);
      expect(info.isBreak).toBe(false);
    });

    it("returns correct info for break day", () => {
      const info = getSprintInfo(new Date("2025-01-18T12:00:00Z"));
      expect(info.day).toBe(14);
      expect(info.isPlanningWindow).toBe(false);
      expect(info.isBreak).toBe(true);
    });
  });
});
