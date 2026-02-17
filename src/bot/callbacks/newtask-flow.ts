import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { nanoid } from "nanoid";
import { getServiceClient } from "../../api/kan-client.js";
import { getDefaultBoardConfig } from "../../db/queries.js";

const KAN_BASE_URL = process.env.KAN_BASE_URL || "https://tasks.xdeca.com";

// --- startNewTaskFlow types and function ---

export type FlowStartResult =
  | { type: "created"; text: string }
  | { type: "picker"; text: string; keyboard: InlineKeyboard }
  | { type: "error"; text: string };

export interface StartFlowParams {
  title: string;
  chatId: number;
  workspacePublicId: string;
  mentionsProvided: boolean;
  resolvedMembers: Array<{ memberPublicId: string; displayName: string }>;
  unresolvedMentions: string[];
}

/**
 * Decides whether a task can be created immediately or needs interactive pickers.
 * Returns either the created-task text or a picker keyboard for the caller to present.
 */
export async function startNewTaskFlow(params: StartFlowParams): Promise<FlowStartResult> {
  const { title, chatId, workspacePublicId, mentionsProvided, resolvedMembers, unresolvedMentions } = params;
  const client = getServiceClient();

  const memberPublicIds = resolvedMembers.map((r) => r.memberPublicId);
  const memberNames = resolvedMembers.map((r) => r.displayName);

  // Check default board config
  const defaultConfig = await getDefaultBoardConfig(chatId);

  // Helper to format the "created" response
  const formatCreatedText = (boardName: string, listName: string, cardPublicId: string): string => {
    const cardUrl = `${KAN_BASE_URL}/card/${cardPublicId}`;
    let response = `Task created in *${boardName}* → ${listName}:\n\n` +
      `*${title}*\n` +
      `[Open in Kan](${cardUrl})`;

    if (memberNames.length > 0) {
      response += `\n\nAssigned to: ${memberNames.join(", ")}`;
    }
    if (unresolvedMentions.length > 0) {
      const names = unresolvedMentions.map((u) => `@${u}`).join(", ");
      response += `\n\n⚠️ Could not resolve: ${names} (use \`/map\` to link their accounts)`;
    }
    return response;
  };

  // Helper to build flow base data
  const buildFlowData = (): Omit<PendingNewTask, "id" | "createdAt"> => ({
    title,
    chatId,
    workspacePublicId,
    mentionsProvided,
    selectedMemberIds: memberPublicIds,
    selectedMemberNames: memberNames,
    unresolvedMentions,
    step: "board",
  });

  // Helper to show assignee picker for a resolved board+list
  const assigneePickerResult = async (
    flowData: Omit<PendingNewTask, "id" | "createdAt">,
  ): Promise<FlowStartResult> => {
    flowData.step = "assignees";
    const flowId = storeFlow(flowData);

    const workspace = await client.getWorkspace(workspacePublicId);
    const availableMembers = workspace.members
      .filter((m) => m.status === "active")
      .map((m) => ({ publicId: m.publicId, name: m.user?.name ?? m.email }));

    const storedFlow = getFlow(flowId);
    if (storedFlow) storedFlow.availableMembers = availableMembers;

    const keyboard = buildAssigneeKeyboard(flowId, availableMembers, []);
    const text =
      `*${title}*\n\n` +
      `Board: *${flowData.boardName}* → ${flowData.listName}\n\n` +
      `Select assignees:`;
    return { type: "picker", text, keyboard };
  };

  if (defaultConfig && mentionsProvided) {
    // Fast path: default + mentions → create immediately
    const card = await client.createCard(defaultConfig.listPublicId, {
      title,
      memberPublicIds: memberPublicIds.length > 0 ? memberPublicIds : undefined,
    });
    return {
      type: "created",
      text: formatCreatedText(defaultConfig.boardName, defaultConfig.listName, card.publicId),
    };
  }

  if (defaultConfig && !mentionsProvided) {
    // Default set, no mentions → assignee picker
    const flowData = buildFlowData();
    flowData.boardPublicId = defaultConfig.boardPublicId;
    flowData.boardName = defaultConfig.boardName;
    flowData.listPublicId = defaultConfig.listPublicId;
    flowData.listName = defaultConfig.listName;
    return assigneePickerResult(flowData);
  }

  // No default → need board/list selection
  const boards = await client.getBoards(workspacePublicId);
  if (!boards.length) {
    return { type: "error", text: "No boards found in this workspace. Create a board first." };
  }

  // Auto-select if only 1 board
  if (boards.length === 1) {
    const board = boards[0];
    const fullBoard = await client.getBoard(board.publicId);
    const lists = (fullBoard.lists || []).map((l) => ({ publicId: l.publicId, name: l.name }));

    if (!lists.length) {
      return { type: "error", text: "No lists found in this board. Create a list first." };
    }

    const flowData = buildFlowData();
    flowData.boardPublicId = board.publicId;
    flowData.boardName = fullBoard.name;
    flowData.lists = lists;

    // Auto-select if only 1 list
    if (lists.length === 1) {
      flowData.listPublicId = lists[0].publicId;
      flowData.listName = lists[0].name;

      if (mentionsProvided) {
        // Both auto-selected, mentions provided → create immediately
        const card = await client.createCard(lists[0].publicId, {
          title,
          memberPublicIds: memberPublicIds.length > 0 ? memberPublicIds : undefined,
        });
        return {
          type: "created",
          text: formatCreatedText(fullBoard.name, lists[0].name, card.publicId),
        };
      }

      // Auto-selected board+list, no mentions → assignee picker
      return assigneePickerResult(flowData);
    }

    // Multiple lists → list picker
    flowData.step = "list";
    const flowId = storeFlow(flowData);
    const keyboard = buildListKeyboard(flowId, lists);
    return {
      type: "picker",
      text: `*${title}*\n\nBoard: *${fullBoard.name}*\n\nSelect a list:`,
      keyboard,
    };
  }

  // Multiple boards → board picker
  const flowData = buildFlowData();
  const flowId = storeFlow(flowData);
  const boardOptions = boards.map((b) => ({ publicId: b.publicId, name: b.name }));
  const keyboard = buildBoardKeyboard(flowId, boardOptions);
  return {
    type: "picker",
    text: `*${title}*\n\nSelect a board:`,
    keyboard,
  };
}

export interface PendingNewTask {
  id: string;
  title: string;
  chatId: number;
  workspacePublicId: string;
  /** Board selection (set from default or picker) */
  boardPublicId?: string;
  boardName?: string;
  listPublicId?: string;
  listName?: string;
  /** Cached lists for the selected board */
  lists?: Array<{ publicId: string; name: string }>;
  /** Whether @mentions were provided in the original command */
  mentionsProvided: boolean;
  /** Member IDs selected via @mentions or picker */
  selectedMemberIds: string[];
  selectedMemberNames: string[];
  /** Workspace members available for assignment */
  availableMembers?: Array<{ publicId: string; name: string }>;
  /** @mentions that couldn't be resolved to Kan members */
  unresolvedMentions: string[];
  step: "board" | "list" | "assignees" | "ready";
  createdAt: number;
}

// In-memory store with 10-minute TTL
const pendingFlows = new Map<string, PendingNewTask>();
const TTL_MS = 10 * 60 * 1000;

export function storeFlow(data: Omit<PendingNewTask, "id" | "createdAt">): string {
  const id = nanoid(10);
  pendingFlows.set(id, { ...data, id, createdAt: Date.now() });
  return id;
}

export function getFlow(id: string): PendingNewTask | undefined {
  const flow = pendingFlows.get(id);
  if (!flow) return undefined;
  if (Date.now() - flow.createdAt > TTL_MS) {
    pendingFlows.delete(id);
    return undefined;
  }
  return flow;
}

export function deleteFlow(id: string): void {
  pendingFlows.delete(id);
}

/** Build inline keyboard showing boards to choose from */
export function buildBoardKeyboard(
  flowId: string,
  boards: Array<{ publicId: string; name: string }>,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let i = 0; i < boards.length; i++) {
    keyboard.text(boards[i].name, `nt:b:${flowId}:${i}`).row();
  }
  keyboard.text("Cancel", `nt:x:${flowId}`);
  return keyboard;
}

/** Build inline keyboard showing lists to choose from */
export function buildListKeyboard(
  flowId: string,
  lists: Array<{ publicId: string; name: string }>,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let i = 0; i < lists.length; i++) {
    keyboard.text(lists[i].name, `nt:l:${flowId}:${i}`).row();
  }
  keyboard.text("Cancel", `nt:x:${flowId}`);
  return keyboard;
}

/** Build inline keyboard showing workspace members with toggle checkmarks */
export function buildAssigneeKeyboard(
  flowId: string,
  members: Array<{ publicId: string; name: string }>,
  selectedIds: string[],
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let i = 0; i < members.length; i++) {
    const isSelected = selectedIds.includes(members[i].publicId);
    const label = isSelected ? `✓ ${members[i].name}` : members[i].name;
    keyboard.text(label, `nt:m:${flowId}:${i}`).row();
  }
  const selectedCount = selectedIds.length;
  keyboard
    .text(`Done${selectedCount > 0 ? ` (${selectedCount})` : ""}`, `nt:ok:${flowId}`)
    .text("Skip", `nt:sk:${flowId}`)
    .text("Cancel", `nt:x:${flowId}`);
  return keyboard;
}

/** Shared helper to create the card from a completed flow */
async function createTaskFromFlow(ctx: Context, flow: PendingNewTask): Promise<void> {
  const client = getServiceClient();
  const card = await client.createCard(flow.listPublicId!, {
    title: flow.title,
    memberPublicIds: flow.selectedMemberIds.length > 0 ? flow.selectedMemberIds : undefined,
  });

  const cardUrl = `${KAN_BASE_URL}/card/${card.publicId}`;
  let response = `Task created in *${flow.boardName}* → ${flow.listName}:\n\n` +
    `*${flow.title}*\n` +
    `[Open in Kan](${cardUrl})`;

  if (flow.selectedMemberNames.length > 0) {
    response += `\n\nAssigned to: ${flow.selectedMemberNames.join(", ")}`;
  }

  if (flow.unresolvedMentions.length > 0) {
    const names = flow.unresolvedMentions.map((u) => `@${u}`).join(", ");
    response += `\n\n⚠️ Could not resolve: ${names} (use \`/map\` to link their accounts)`;
  }

  await ctx.editMessageText(response, {
    parse_mode: "Markdown",
    link_preview_options: { is_disabled: true },
  });
  deleteFlow(flow.id);
}

/** Show the assignee picker for a flow, fetching workspace members if needed */
async function showAssigneePicker(ctx: Context, flow: PendingNewTask): Promise<void> {
  if (!flow.availableMembers) {
    const client = getServiceClient();
    const workspace = await client.getWorkspace(flow.workspacePublicId);
    flow.availableMembers = workspace.members
      .filter((m) => m.status === "active")
      .map((m) => ({
        publicId: m.publicId,
        name: m.user?.name ?? m.email,
      }));
  }

  flow.step = "assignees";
  const keyboard = buildAssigneeKeyboard(flow.id, flow.availableMembers, flow.selectedMemberIds);

  await ctx.editMessageText(
    `*${flow.title}*\n\n` +
    `Board: *${flow.boardName}* → ${flow.listName}\n\n` +
    `Select assignees:`,
    { parse_mode: "Markdown", reply_markup: keyboard },
  );
}

/** Callback: user selected a board */
export async function handleNewTaskBoardCallback(ctx: Context) {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    await ctx.answerCallbackQuery({ text: "Invalid action." });
    return;
  }

  // Format: nt:b:<flowId>:<boardIdx>
  const parts = data.replace("nt:b:", "").split(":");
  if (parts.length < 2) {
    await ctx.answerCallbackQuery({ text: "Invalid selection." });
    return;
  }

  const [flowId, boardIdxStr] = parts;
  const flow = getFlow(flowId);
  if (!flow) {
    await ctx.answerCallbackQuery({ text: "This selection has expired." });
    await ctx.editMessageText("_Selection expired._", { parse_mode: "Markdown" });
    return;
  }

  const boardIdx = parseInt(boardIdxStr, 10);
  // boards are stored transiently - we need to fetch them
  const client = getServiceClient();
  const boards = await client.getBoards(flow.workspacePublicId);
  const board = boards[boardIdx];

  if (!board) {
    await ctx.answerCallbackQuery({ text: "Invalid board selection." });
    return;
  }

  try {
    const fullBoard = await client.getBoard(board.publicId);
    const lists = (fullBoard.lists || []).map((l) => ({ publicId: l.publicId, name: l.name }));

    if (!lists.length) {
      await ctx.answerCallbackQuery({ text: "No lists found in this board." });
      return;
    }

    flow.boardPublicId = board.publicId;
    flow.boardName = fullBoard.name;
    flow.lists = lists;

    // Auto-select if only 1 list
    if (lists.length === 1) {
      flow.listPublicId = lists[0].publicId;
      flow.listName = lists[0].name;

      if (flow.mentionsProvided) {
        // Mentions already set — create immediately
        await createTaskFromFlow(ctx, flow);
        await ctx.answerCallbackQuery({ text: "Task created!" });
      } else {
        await showAssigneePicker(ctx, flow);
        await ctx.answerCallbackQuery();
      }
      return;
    }

    // Show list picker
    flow.step = "list";
    const keyboard = buildListKeyboard(flow.id, lists);

    await ctx.editMessageText(
      `*${flow.title}*\n\nBoard: *${fullBoard.name}*\n\nSelect a list:`,
      { parse_mode: "Markdown", reply_markup: keyboard },
    );
    await ctx.answerCallbackQuery();
  } catch (error) {
    console.error("Error in newtask board callback:", error);
    await ctx.answerCallbackQuery({ text: "Error fetching board details." });
  }
}

/** Callback: user selected a list */
export async function handleNewTaskListCallback(ctx: Context) {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    await ctx.answerCallbackQuery({ text: "Invalid action." });
    return;
  }

  // Format: nt:l:<flowId>:<listIdx>
  const parts = data.replace("nt:l:", "").split(":");
  if (parts.length < 2) {
    await ctx.answerCallbackQuery({ text: "Invalid selection." });
    return;
  }

  const [flowId, listIdxStr] = parts;
  const flow = getFlow(flowId);
  if (!flow) {
    await ctx.answerCallbackQuery({ text: "This selection has expired." });
    await ctx.editMessageText("_Selection expired._", { parse_mode: "Markdown" });
    return;
  }

  const listIdx = parseInt(listIdxStr, 10);
  const list = flow.lists?.[listIdx];
  if (!list) {
    await ctx.answerCallbackQuery({ text: "Invalid list selection." });
    return;
  }

  try {
    flow.listPublicId = list.publicId;
    flow.listName = list.name;

    if (flow.mentionsProvided) {
      // Mentions already set — create immediately
      await createTaskFromFlow(ctx, flow);
      await ctx.answerCallbackQuery({ text: "Task created!" });
    } else {
      await showAssigneePicker(ctx, flow);
      await ctx.answerCallbackQuery();
    }
  } catch (error) {
    console.error("Error in newtask list callback:", error);
    await ctx.answerCallbackQuery({ text: "Error processing selection." });
  }
}

/** Callback: user toggled a member on/off */
export async function handleNewTaskMemberToggleCallback(ctx: Context) {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    await ctx.answerCallbackQuery({ text: "Invalid action." });
    return;
  }

  // Format: nt:m:<flowId>:<memberIdx>
  const parts = data.replace("nt:m:", "").split(":");
  if (parts.length < 2) {
    await ctx.answerCallbackQuery({ text: "Invalid selection." });
    return;
  }

  const [flowId, memberIdxStr] = parts;
  const flow = getFlow(flowId);
  if (!flow) {
    await ctx.answerCallbackQuery({ text: "This selection has expired." });
    await ctx.editMessageText("_Selection expired._", { parse_mode: "Markdown" });
    return;
  }

  const memberIdx = parseInt(memberIdxStr, 10);
  const member = flow.availableMembers?.[memberIdx];
  if (!member) {
    await ctx.answerCallbackQuery({ text: "Invalid member." });
    return;
  }

  // Toggle
  const existingIndex = flow.selectedMemberIds.indexOf(member.publicId);
  if (existingIndex >= 0) {
    flow.selectedMemberIds.splice(existingIndex, 1);
    flow.selectedMemberNames.splice(existingIndex, 1);
  } else {
    flow.selectedMemberIds.push(member.publicId);
    flow.selectedMemberNames.push(member.name);
  }

  // Rebuild keyboard with updated checkmarks
  const keyboard = buildAssigneeKeyboard(flow.id, flow.availableMembers!, flow.selectedMemberIds);

  await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
  await ctx.answerCallbackQuery();
}

/** Callback: user confirmed assignees (Done button) */
export async function handleNewTaskDoneCallback(ctx: Context) {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    await ctx.answerCallbackQuery({ text: "Invalid action." });
    return;
  }

  const flowId = data.replace("nt:ok:", "");
  const flow = getFlow(flowId);
  if (!flow) {
    await ctx.answerCallbackQuery({ text: "This selection has expired." });
    await ctx.editMessageText("_Selection expired._", { parse_mode: "Markdown" });
    return;
  }

  try {
    await createTaskFromFlow(ctx, flow);
    await ctx.answerCallbackQuery({ text: "Task created!" });
  } catch (error) {
    console.error("Error creating task from flow:", error);
    await ctx.answerCallbackQuery({ text: "Error creating task." });
  }
}

/** Callback: user skipped assignee selection */
export async function handleNewTaskSkipCallback(ctx: Context) {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    await ctx.answerCallbackQuery({ text: "Invalid action." });
    return;
  }

  const flowId = data.replace("nt:sk:", "");
  const flow = getFlow(flowId);
  if (!flow) {
    await ctx.answerCallbackQuery({ text: "This selection has expired." });
    await ctx.editMessageText("_Selection expired._", { parse_mode: "Markdown" });
    return;
  }

  try {
    // Clear any selections — create without assignees
    flow.selectedMemberIds = [];
    flow.selectedMemberNames = [];
    await createTaskFromFlow(ctx, flow);
    await ctx.answerCallbackQuery({ text: "Task created!" });
  } catch (error) {
    console.error("Error creating task (skip assignees):", error);
    await ctx.answerCallbackQuery({ text: "Error creating task." });
  }
}

/** Callback: user cancelled the flow */
export async function handleNewTaskCancelCallback(ctx: Context) {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    await ctx.answerCallbackQuery({ text: "Invalid action." });
    return;
  }

  const flowId = data.replace("nt:x:", "");
  deleteFlow(flowId);

  await ctx.editMessageText("_Cancelled._", { parse_mode: "Markdown" });
  await ctx.answerCallbackQuery({ text: "Cancelled." });
}

// Clean expired flows periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, flow] of pendingFlows.entries()) {
    if (now - flow.createdAt > TTL_MS) {
      pendingFlows.delete(id);
    }
  }
}, 5 * 60 * 1000);
