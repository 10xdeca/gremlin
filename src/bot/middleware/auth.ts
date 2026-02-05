import type { Context, NextFunction } from "grammy";
import { getWorkspaceLink } from "../../db/queries.js";
import { getServiceClient, type KanApiClient } from "../../api/kan-client.js";

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
