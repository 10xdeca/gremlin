import { getDefaultBoardConfig } from "../db/queries.js";
import { getServiceClient } from "../api/kan-client.js";

export interface ResolvedList {
  listPublicId: string;
  listName: string;
  boardName: string;
}

/**
 * Resolves the target list for card creation.
 * Uses default board config if set, otherwise auto-detects Backlog/To Do on the first board.
 */
export async function resolveTargetList(
  chatId: number,
  workspacePublicId: string
): Promise<ResolvedList | null> {
  const config = await getDefaultBoardConfig(chatId);

  if (config) {
    return {
      listPublicId: config.listPublicId,
      listName: config.listName,
      boardName: config.boardName,
    };
  }

  // Auto-detect: first board, Backlog/To Do/first list
  const client = getServiceClient();
  const boards = await client.getBoards(workspacePublicId);
  if (!boards.length) return null;

  const board = boards[0];
  const list = await client.findBacklogOrTodoList(board.publicId);
  if (!list) return null;

  return {
    listPublicId: list.publicId,
    listName: list.name,
    boardName: board.name,
  };
}
