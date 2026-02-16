import type { Context } from "grammy";
import { getBotIdentity } from "../../services/bot-identity.js";

export async function helpCommand(ctx: Context) {
  const identity = await getBotIdentity();

  const helpText = `
*${identity.name} - Task Management*

*Setup Commands (Admin):*
\`/start <workspace>\` - Link this chat to a Kan workspace
\`/map @user email\` - Map a Telegram user to their Kan email (DM only)
\`/settopic\` - Set reminders to post in this topic
\`/unlink\` - Unlink this chat from its workspace

*User Commands:*
\`/link\` - Check your account mapping status
\`/unlinkme\` - Remove your account mapping

*Task Commands:*
\`/mytasks\` - View your assigned tasks
\`/overdue\` - View all overdue tasks in the workspace
\`/done <task-id>\` - Mark a task as complete
\`/comment <task-id> <text>\` - Add a comment to a task

*Identity:*
\`/namingceremony\` - Start a bot naming ceremony (admin)
\`/concludeceremony\` - End the naming ceremony early (admin)

*Automatic Reminders:*
• Overdue tasks - daily
• Stale tasks (in progress >14 days) - every 2 days
• Unassigned tasks - every 2 days
• Sprint start (days 1-2): vague tasks, missing due dates, people with no tasks
`;

  await ctx.reply(helpText, { parse_mode: "Markdown" });
}
