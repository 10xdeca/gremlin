// Sprint timing utilities
// Sprints are 13 days, starting on Sunday and ending on Friday
// Saturday is a break day between sprints

const SPRINT_LENGTH_DAYS = 14; // 13 sprint days + 1 break day

// Get a known sprint start date from env, or default to a Sunday
// This can be any past sprint start - we'll calculate from there
function getSprintEpoch(): Date {
  const envDate = process.env.SPRINT_START_DATE;
  if (envDate) {
    const date = new Date(envDate);
    if (!isNaN(date.getTime())) {
      return date;
    }
  }
  // Default: Jan 5, 2025 (a Sunday)
  return new Date("2025-01-05");
}

/**
 * Get the current day of the sprint (1-14)
 * Day 1 = Sunday (sprint start)
 * Day 2 = Monday
 * Day 7 = Saturday (mid-sprint)
 * Day 13 = Friday (sprint end)
 * Day 14 = Saturday (break day)
 */
export function getSprintDay(now: Date = new Date()): number {
  const epoch = getSprintEpoch();
  const msPerDay = 24 * 60 * 60 * 1000;

  // Calculate days since sprint epoch
  const daysSinceEpoch = Math.floor((now.getTime() - epoch.getTime()) / msPerDay);

  // Get day within current sprint (0-13), then convert to 1-14
  const dayInSprint = ((daysSinceEpoch % SPRINT_LENGTH_DAYS) + SPRINT_LENGTH_DAYS) % SPRINT_LENGTH_DAYS;
  return dayInSprint + 1;
}

/**
 * Check if we're in the sprint planning window (days 1-2)
 * This is when we should nag about vague tasks and missing due dates
 * Day 1 = Sunday, Day 2 = Monday
 */
export function isSprintPlanningWindow(now: Date = new Date()): boolean {
  const day = getSprintDay(now);
  return day <= 2; // Sunday and Monday of sprint start
}

/**
 * Check if it's the mid-sprint day (Saturday, day 7)
 */
export function isMidSprintDay(now: Date = new Date()): boolean {
  return getSprintDay(now) === 7;
}

/**
 * Check if it's the last day of sprint (Friday, day 13)
 */
export function isSprintEndDay(now: Date = new Date()): boolean {
  return getSprintDay(now) === 13;
}

/**
 * Check if it's break day (Saturday, day 14)
 */
export function isBreakDay(now: Date = new Date()): boolean {
  return getSprintDay(now) === 14;
}

/**
 * Get sprint info for debugging/display
 */
export function getSprintInfo(now: Date = new Date()): {
  day: number;
  isPlanningWindow: boolean;
  isMidSprint: boolean;
  isSprintEnd: boolean;
  isBreak: boolean;
} {
  const day = getSprintDay(now);
  return {
    day,
    isPlanningWindow: day <= 2,
    isMidSprint: day === 7,
    isSprintEnd: day === 13,
    isBreak: day === 14,
  };
}
