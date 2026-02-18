/**
 * Timezone-aware date/time utilities for standup scheduling.
 * Uses Intl.DateTimeFormat for timezone conversions (no external deps).
 */

/** Returns "YYYY-MM-DD" for "today" in the given IANA timezone. */
export function getTodayInTimezone(timezone: string, now: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA locale formats as YYYY-MM-DD
  return formatter.format(now);
}

/** Returns the current hour (0-23) in the given IANA timezone. */
export function getCurrentHourInTimezone(timezone: string, now: Date = new Date()): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  });
  // Returns "0" through "23" (or "24" for midnight in some locales, which we map to 0)
  const hour = parseInt(formatter.format(now), 10);
  return hour === 24 ? 0 : hour;
}

/** Returns true if the current day in the given timezone is Saturday (6) or Sunday (0). */
export function isWeekendInTimezone(timezone: string, now: Date = new Date()): boolean {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  });
  const day = formatter.format(now);
  return day === "Sat" || day === "Sun";
}
