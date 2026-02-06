import type { Context, NextFunction } from "grammy";
import { getWorkspaceLink } from "../../db/queries.js";
import { getServiceClient, type KanApiClient } from "../../api/kan-client.js";

// Parse admin user IDs from environment variable
const ADMIN_USER_IDS: Set<number> = new Set(
  (process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !isNaN(id))
);

// Check if a user is an admin
export function isAdmin(userId: number | undefined): boolean {
  if (!userId) return false;
  return ADMIN_USER_IDS.has(userId);
}

// Reply with access denied message
export async function replyNotAdmin(ctx: Context): Promise<void> {
  await ctx.reply("You don't have permission to use this command.");
}

export interface AuthContext extends Context {
  kanClient?: KanApiClient;
  workspacePublicId?: string;
  workspaceName?: string;
}

// Middleware that provides the service client
export async function provideClient(ctx: AuthContext, next: NextFunction) {
  ctx.kanClient = getServiceClient();
  return next();
}

// Middleware that checks if the chat has a linked workspace
export async function requireWorkspaceLink(ctx: AuthContext, next: NextFunction) {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply("Could not identify chat.");
    return;
  }

  const workspaceLink = await getWorkspaceLink(chatId);
  if (!workspaceLink) {
    await ctx.reply(
      "This chat isn't linked to a Kan workspace yet.\n\n" +
        "Use /start <workspace-id-or-slug> to connect this chat to a workspace."
    );
    return;
  }

  ctx.workspacePublicId = workspaceLink.workspacePublicId;
  ctx.workspaceName = workspaceLink.workspaceName;
  ctx.kanClient = getServiceClient();
  return next();
}

// Combined middleware for commands that need workspace access
export async function requireAuth(ctx: AuthContext, next: NextFunction) {
  await requireWorkspaceLink(ctx, next);
}
