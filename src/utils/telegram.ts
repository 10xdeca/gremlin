import { deleteWorkspaceLink } from "../db/queries.js";

/**
 * Check if a Telegram API error indicates the chat is permanently unreachable.
 * This covers: chat deleted, bot removed/kicked, bot blocked by user, etc.
 */
export function isChatUnreachable(error: unknown): boolean {
  const err = error as { error_code?: number; description?: string };
  if (!err.error_code) return false;

  // 400: "Bad Request: chat not found" — chat deleted or ID invalid
  if (err.error_code === 400 && err.description?.includes("chat not found")) {
    return true;
  }

  // 403: "Forbidden: bot was kicked/blocked" — bot removed from group or blocked by user
  if (err.error_code === 403) {
    return true;
  }

  return false;
}

/**
 * Handle an unreachable chat by removing its workspace link.
 * Returns true if the chat was unreachable and the link was removed.
 */
export async function handleUnreachableChat(
  error: unknown,
  chatId: number,
): Promise<boolean> {
  if (!isChatUnreachable(error)) return false;

  console.warn(
    `Chat ${chatId} is unreachable (${(error as { description?: string }).description}), removing workspace link`,
  );
  await deleteWorkspaceLink(chatId);
  return true;
}
