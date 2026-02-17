import { getUserLinkByTelegramUsername } from "../db/queries.js";

export interface ParsedMentions {
  /** Message text with @mentions stripped out */
  cleanText: string;
  /** Telegram usernames mentioned (without the @ prefix) */
  usernames: string[];
}

/**
 * Extracts @mentions from message text and returns the cleaned text plus usernames.
 * Optionally filters out the bot's own username.
 */
export function extractMentions(text: string, botUsername?: string): ParsedMentions {
  const mentionRegex = /@(\w+)/g;
  const usernames: string[] = [];

  let match;
  while ((match = mentionRegex.exec(text)) !== null) {
    const username = match[1];
    if (botUsername && username.toLowerCase() === botUsername.toLowerCase()) {
      continue;
    }
    usernames.push(username);
  }

  // Strip @mentions from the text
  const cleanText = text.replace(/@\w+/g, "").replace(/\s+/g, " ").trim();

  return { cleanText, usernames };
}

export interface ResolvedMember {
  username: string;
  memberPublicId: string;
}

/**
 * Resolves Telegram usernames to Kan workspace member IDs via telegram_user_links.
 * Returns resolved members and unresolved usernames separately.
 */
export async function resolveMentionsToMembers(usernames: string[]): Promise<{
  resolved: ResolvedMember[];
  unresolved: string[];
}> {
  const resolved: ResolvedMember[] = [];
  const unresolved: string[] = [];

  for (const username of usernames) {
    const userLink = await getUserLinkByTelegramUsername(username);
    if (userLink?.workspaceMemberPublicId) {
      resolved.push({
        username,
        memberPublicId: userLink.workspaceMemberPublicId,
      });
    } else {
      unresolved.push(username);
    }
  }

  return { resolved, unresolved };
}
