import { registerCustomTool } from "../agent/tool-registry.js";
import {
  getKickstartSession,
  createKickstartSession,
  advanceKickstartStep,
  completeKickstart,
  abandonKickstart,
} from "../db/queries.js";

/** Register kickstart onboarding tools. */
export function registerKickstartTools(): void {
  registerCustomTool({
    name: "get_kickstart_state",
    description:
      "Get the current kickstart onboarding state for this chat. Returns the current step (1-6), status, and notes from completed steps.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "Telegram chat ID" },
      },
      required: ["chat_id"],
    },
    handler: async (args) => {
      const session = await getKickstartSession(args.chat_id as number);
      if (!session) {
        return JSON.stringify({ active: false });
      }
      return JSON.stringify({
        active: true,
        currentStep: session.currentStep,
        status: session.status,
        stepData: session.stepData ? JSON.parse(session.stepData) : {},
        startedAt: session.startedAt,
      });
    },
  });

  registerCustomTool({
    name: "start_kickstart",
    description:
      "Start a kickstart onboarding flow for this chat. Admin only. Creates a new session starting at step 1 (Workspace Setup). Any existing active kickstart is abandoned.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "Telegram chat ID" },
        user_id: {
          type: "number",
          description: "Telegram user ID of the admin starting kickstart",
        },
      },
      required: ["chat_id", "user_id"],
    },
    handler: async (args) => {
      await createKickstartSession({
        telegramChatId: args.chat_id as number,
        initiatedByUserId: args.user_id as number,
      });
      return JSON.stringify({
        success: true,
        message: "Kickstart started at step 1: Workspace Setup",
      });
    },
  });

  registerCustomTool({
    name: "advance_kickstart",
    description:
      "Mark the current kickstart step as complete and advance to the next step. Include a brief note summarising what was configured (used in the final summary).",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "Telegram chat ID" },
        step_note: {
          type: "string",
          description:
            "Brief summary of what was configured in this step (e.g. 'Linked workspace: xdeca')",
        },
      },
      required: ["chat_id", "step_note"],
    },
    handler: async (args) => {
      const result = await advanceKickstartStep(
        args.chat_id as number,
        args.step_note as string
      );
      if (!result) {
        return JSON.stringify({ error: "No active kickstart session" });
      }
      const session = await getKickstartSession(args.chat_id as number);
      const stepNames = [
        "",
        "Workspace Setup",
        "Board & Topics",
        "Team Roster",
        "Project Seeding",
        "Standup Config",
        "Summary & Go",
      ];
      return JSON.stringify({
        success: true,
        newStep: session?.currentStep ?? 7,
        newStepName: session
          ? stepNames[session.currentStep] ?? "Complete"
          : "Complete",
      });
    },
  });

  registerCustomTool({
    name: "complete_kickstart",
    description:
      "Mark the kickstart as fully complete. Call this after presenting the final summary in step 6.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "Telegram chat ID" },
      },
      required: ["chat_id"],
    },
    handler: async (args) => {
      await completeKickstart(args.chat_id as number);
      return JSON.stringify({
        success: true,
        message: "Kickstart complete! This chat is fully configured.",
      });
    },
  });

  registerCustomTool({
    name: "cancel_kickstart",
    description:
      "Cancel/abandon an active kickstart session. Use when the user says 'cancel kickstart' or wants to stop the setup flow.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "Telegram chat ID" },
      },
      required: ["chat_id"],
    },
    handler: async (args) => {
      const session = await getKickstartSession(args.chat_id as number);
      if (!session) {
        return JSON.stringify({ error: "No active kickstart to cancel" });
      }
      await abandonKickstart(args.chat_id as number);
      return JSON.stringify({
        success: true,
        message: "Kickstart cancelled. You can start a new one anytime.",
      });
    },
  });
}
