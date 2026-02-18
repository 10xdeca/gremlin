/**
 * Deterministic (no LLM) standup summary formatter.
 * Takes responses and expected users, returns a formatted Telegram message.
 */

export interface StandupResponse {
  telegramUsername: string | null;
  telegramUserId: number;
  yesterday: string | null;
  today: string | null;
  blockers: string | null;
}

export interface StandupSummaryInput {
  date: string;
  responses: StandupResponse[];
  /** Usernames of all mapped users expected to respond. */
  expectedUsernames: string[];
}

/** Format a standup summary for posting to Telegram (MarkdownV2). */
export function formatStandupSummary(input: StandupSummaryInput): string {
  const { date, responses, expectedUsernames } = input;
  const parts: string[] = [];

  // Header
  parts.push(
    esc(`Standup Summary — ${date}`) +
    ` \\(${responses.length}/${expectedUsernames.length} responded\\)`
  );
  parts.push("");

  // Each respondent's update
  for (const r of responses) {
    const name = r.telegramUsername ? `@${r.telegramUsername}` : `User ${r.telegramUserId}`;
    parts.push(`*${esc(name)}*`);

    if (r.yesterday) parts.push(`  Yesterday: ${esc(r.yesterday)}`);
    if (r.today) parts.push(`  Today: ${esc(r.today)}`);
    if (r.blockers) parts.push(`  Blockers: ${esc(r.blockers)}`);

    // If none of the fields were set, note it
    if (!r.yesterday && !r.today && !r.blockers) {
      parts.push(`  _No details parsed_`);
    }
    parts.push("");
  }

  // Missing users
  const respondedUsernames = new Set(
    responses
      .map((r) => r.telegramUsername?.toLowerCase())
      .filter(Boolean)
  );
  const missing = expectedUsernames.filter(
    (u) => !respondedUsernames.has(u.toLowerCase())
  );

  if (missing.length > 0) {
    parts.push(`*Missing:* ${missing.map((u) => `@${u}`).join(", ")}`);
  }

  return parts.join("\n");
}

/** Escape MarkdownV2 special characters. */
function esc(text: string): string {
  return text.replace(/[_*\[\]()~`>#+=|{}.!-]/g, "\\$&");
}
