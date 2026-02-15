const KAN_BASE_URL = process.env.KAN_BASE_URL || "https://tasks.xdeca.com";

export interface KanUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
}

export interface KanWorkspace {
  id: number;
  publicId: string;
  name: string;
  slug: string;
  description: string | null;
}

export interface KanWorkspaceMember {
  id: number;
  publicId: string;
  email: string;
  role: "admin" | "member" | "guest";
  status: "invited" | "active" | "removed" | "paused";
  user: KanUser | null;
}

export interface KanBoard {
  id: number;
  publicId: string;
  name: string;
  slug: string;
  lists?: KanList[];
}

export interface KanList {
  id: number;
  publicId: string;
  name: string;
  index: number;
  cards?: KanCard[];
}

export interface KanCard {
  id: number;
  publicId: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  listId: number;
  list?: { publicId: string; name: string };
  members?: KanWorkspaceMember[];
  labels?: KanLabel[];
  createdBy?: KanUser;
}

export interface KanLabel {
  id: number;
  publicId: string;
  name: string;
  color: string;
}

export interface KanComment {
  id: number;
  publicId: string;
  comment: string;
  createdAt: string;
  createdBy: KanUser | null;
}

class KanApiClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${KAN_BASE_URL}/api/v1${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Kan API error (${response.status}): ${error}`);
    }

    return response.json();
  }

  // User
  async getMe(): Promise<KanUser> {
    return this.request("GET", "/users/me");
  }

  // Workspaces
  async getWorkspaces(): Promise<KanWorkspace[]> {
    // API returns { role, workspace: {...} }[] so we need to map it
    const result = await this.request<Array<{ role: string; workspace: KanWorkspace }>>(
      "GET",
      "/workspaces"
    );
    return result.map((item) => item.workspace);
  }

  async getWorkspace(publicId: string): Promise<KanWorkspace & { members: KanWorkspaceMember[] }> {
    return this.request("GET", `/workspaces/${publicId}`);
  }

  // Boards
  async getBoards(workspacePublicId: string): Promise<KanBoard[]> {
    return this.request("GET", `/workspaces/${workspacePublicId}/boards`);
  }

  async getBoard(
    boardPublicId: string,
    filters?: {
      members?: string[];
      dueDateFilters?: string[];
    }
  ): Promise<KanBoard> {
    const params = new URLSearchParams();
    if (filters?.members?.length) {
      // trpc-openapi expects JSON-encoded arrays
      params.set("members", JSON.stringify(filters.members));
    }
    if (filters?.dueDateFilters?.length) {
      params.set("dueDateFilters", JSON.stringify(filters.dueDateFilters));
    }
    const queryString = params.toString();
    const path = `/boards/${boardPublicId}${queryString ? `?${queryString}` : ""}`;
    return this.request("GET", path);
  }

  // Fetch all boards with their lists and cards populated (single batch)
  async getFullBoards(workspacePublicId: string): Promise<KanBoard[]> {
    const boards = await this.getBoards(workspacePublicId);
    const fullBoards: KanBoard[] = [];
    for (const board of boards) {
      const fullBoard = await this.getBoard(board.publicId);
      fullBoards.push(fullBoard);
    }
    return fullBoards;
  }

  // Cards
  async getCard(cardPublicId: string): Promise<KanCard> {
    return this.request("GET", `/cards/${cardPublicId}`);
  }

  async updateCard(
    cardPublicId: string,
    data: {
      title?: string;
      description?: string;
      listPublicId?: string;
      dueDate?: string | null;
    }
  ): Promise<KanCard> {
    return this.request("PUT", `/cards/${cardPublicId}`, data);
  }

  async addComment(cardPublicId: string, comment: string): Promise<KanComment> {
    return this.request("POST", `/cards/${cardPublicId}/comments`, { comment });
  }

  // Search for workspace by slug or name
  async searchWorkspace(query: string): Promise<KanWorkspace | null> {
    const workspaces = await this.getWorkspaces();
    return (
      workspaces.find(
        (w) =>
          w.slug.toLowerCase() === query.toLowerCase() ||
          w.name.toLowerCase().includes(query.toLowerCase())
      ) || null
    );
  }

  // Get all overdue cards in a workspace
  async getOverdueCards(workspacePublicId: string): Promise<
    Array<{
      card: KanCard;
      board: KanBoard;
      list: KanList;
    }>
  > {
    const boards = await this.getBoards(workspacePublicId);
    const overdueCards: Array<{ card: KanCard; board: KanBoard; list: KanList }> = [];

    for (const board of boards) {
      // Fetch all cards and filter client-side (API array params have issues)
      const fullBoard = await this.getBoard(board.publicId);

      for (const list of fullBoard.lists || []) {
        // Skip lists that appear to be "done", "archive", or "backlog" lists
        const listNameLower = list.name.toLowerCase();
        if (
          listNameLower.includes("done") ||
          listNameLower.includes("complete") ||
          listNameLower.includes("archive") ||
          listNameLower.includes("backlog")
        ) {
          continue;
        }

        for (const card of list.cards || []) {
          if (card.dueDate && new Date(card.dueDate) < new Date()) {
            overdueCards.push({ card, board: fullBoard, list });
          }
        }
      }
    }

    return overdueCards;
  }

  // Get cards assigned to a user
  async getCardsForMember(
    workspacePublicId: string,
    memberPublicId: string
  ): Promise<Array<{ card: KanCard; board: KanBoard; list: KanList }>> {
    const boards = await this.getBoards(workspacePublicId);
    const memberCards: Array<{ card: KanCard; board: KanBoard; list: KanList }> = [];

    for (const board of boards) {
      // Fetch all cards and filter client-side (API array params have issues)
      const fullBoard = await this.getBoard(board.publicId);

      for (const list of fullBoard.lists || []) {
        // Skip "done", "archive", and "backlog" lists for active task view
        const listNameLower = list.name.toLowerCase();
        if (
          listNameLower.includes("done") ||
          listNameLower.includes("complete") ||
          listNameLower.includes("archive") ||
          listNameLower.includes("backlog")
        ) {
          continue;
        }

        for (const card of list.cards || []) {
          // Filter by member client-side
          const isAssigned = card.members?.some(
            (m) => m.publicId === memberPublicId
          );
          if (isAssigned) {
            memberCards.push({ card, board: fullBoard, list });
          }
        }
      }
    }

    return memberCards;
  }

  // Find "Done" list in a board
  async findDoneList(boardPublicId: string): Promise<KanList | null> {
    const board = await this.getBoard(boardPublicId);
    for (const list of board.lists || []) {
      const listNameLower = list.name.toLowerCase();
      if (
        listNameLower.includes("done") ||
        listNameLower.includes("complete")
      ) {
        return list;
      }
    }
    return null;
  }

  // Get cards without a due date
  async getCardsWithoutDueDate(workspacePublicId: string): Promise<
    Array<{
      card: KanCard;
      board: KanBoard;
      list: KanList;
    }>
  > {
    const boards = await this.getBoards(workspacePublicId);
    const cards: Array<{ card: KanCard; board: KanBoard; list: KanList }> = [];

    for (const board of boards) {
      const fullBoard = await this.getBoard(board.publicId);

      for (const list of fullBoard.lists || []) {
        // Skip "done" or "archive" lists
        const listNameLower = list.name.toLowerCase();
        if (
          listNameLower.includes("done") ||
          listNameLower.includes("complete") ||
          listNameLower.includes("archive") ||
          listNameLower.includes("backlog")
        ) {
          continue;
        }

        for (const card of list.cards || []) {
          if (!card.dueDate) {
            cards.push({ card, board: fullBoard, list });
          }
        }
      }
    }

    return cards;
  }

  // Get vague tasks - returns candidates for LLM evaluation
  // The actual vagueness check is done by the caller using the evaluator service
  async getVagueTaskCandidates(workspacePublicId: string): Promise<
    Array<{
      card: KanCard;
      board: KanBoard;
      list: KanList;
    }>
  > {
    const boards = await this.getBoards(workspacePublicId);
    const cards: Array<{ card: KanCard; board: KanBoard; list: KanList }> = [];

    for (const board of boards) {
      const fullBoard = await this.getBoard(board.publicId);

      for (const list of fullBoard.lists || []) {
        // Skip "done" or "archive" lists
        const listNameLower = list.name.toLowerCase();
        if (
          listNameLower.includes("done") ||
          listNameLower.includes("complete") ||
          listNameLower.includes("archive")
        ) {
          continue;
        }

        for (const card of list.cards || []) {
          // Pre-filter: only evaluate tasks with short/no descriptions
          // This reduces API calls while still catching most vague tasks
          const descLength = card.description?.trim().length || 0;
          if (descLength < 100) {
            cards.push({ card, board: fullBoard, list });
          }
        }
      }
    }

    return cards;
  }

  // Get stale tasks (in progress > 14 days)
  async getStaleTasks(workspacePublicId: string, staleDays: number = 14): Promise<
    Array<{
      card: KanCard;
      board: KanBoard;
      list: KanList;
      daysInList: number;
    }>
  > {
    const boards = await this.getBoards(workspacePublicId);
    const cards: Array<{ card: KanCard; board: KanBoard; list: KanList; daysInList: number }> = [];
    const staleThreshold = Date.now() - staleDays * 24 * 60 * 60 * 1000;

    for (const board of boards) {
      const fullBoard = await this.getBoard(board.publicId);

      for (const list of fullBoard.lists || []) {
        // Only check "in progress" type lists
        const listNameLower = list.name.toLowerCase();
        if (
          !listNameLower.includes("progress") &&
          !listNameLower.includes("doing") &&
          !listNameLower.includes("working") &&
          !listNameLower.includes("review")
        ) {
          continue;
        }

        for (const card of list.cards || []) {
          // Use card's updatedAt if available, otherwise use a heuristic
          // Since API may not expose updatedAt, we'll check if card has been stale
          // For now, we'll include all cards in progress lists - the reminder system
          // will track when we first notified about staleness
          const cardAny = card as KanCard & { updatedAt?: string; createdAt?: string };
          const lastActivity = cardAny.updatedAt || cardAny.createdAt;

          if (lastActivity) {
            const lastActivityDate = new Date(lastActivity).getTime();
            if (lastActivityDate < staleThreshold) {
              const daysInList = Math.floor((Date.now() - lastActivityDate) / (1000 * 60 * 60 * 24));
              cards.push({ card, board: fullBoard, list, daysInList });
            }
          }
        }
      }
    }

    return cards;
  }

  // Get unassigned tasks
  async getUnassignedTasks(workspacePublicId: string): Promise<
    Array<{
      card: KanCard;
      board: KanBoard;
      list: KanList;
    }>
  > {
    const boards = await this.getBoards(workspacePublicId);
    const cards: Array<{ card: KanCard; board: KanBoard; list: KanList }> = [];

    for (const board of boards) {
      const fullBoard = await this.getBoard(board.publicId);

      for (const list of fullBoard.lists || []) {
        // Skip "done", "archive", or "backlog" lists
        const listNameLower = list.name.toLowerCase();
        if (
          listNameLower.includes("done") ||
          listNameLower.includes("complete") ||
          listNameLower.includes("archive") ||
          listNameLower.includes("backlog")
        ) {
          continue;
        }

        for (const card of list.cards || []) {
          if (!card.members || card.members.length === 0) {
            cards.push({ card, board: fullBoard, list });
          }
        }
      }
    }

    return cards;
  }

  // Get workspace members who have no active tasks assigned
  async getMembersWithNoTasks(workspacePublicId: string): Promise<KanWorkspaceMember[]> {
    const workspace = await this.getWorkspace(workspacePublicId);
    const boards = await this.getBoards(workspacePublicId);

    // Collect all member publicIds who have at least one active task
    const membersWithTasks = new Set<string>();

    for (const board of boards) {
      const fullBoard = await this.getBoard(board.publicId);

      for (const list of fullBoard.lists || []) {
        // Skip "done" or "archive" lists - we want active tasks
        const listNameLower = list.name.toLowerCase();
        if (
          listNameLower.includes("done") ||
          listNameLower.includes("complete") ||
          listNameLower.includes("archive")
        ) {
          continue;
        }

        for (const card of list.cards || []) {
          if (card.members) {
            for (const member of card.members) {
              membersWithTasks.add(member.publicId);
            }
          }
        }
      }
    }

    // Return active members who have no tasks
    return workspace.members.filter(
      (m) => m.status === "active" && !membersWithTasks.has(m.publicId)
    );
  }
}

export function createKanClient(apiKey: string): KanApiClient {
  return new KanApiClient(apiKey);
}

// Get the service client using the KAN_SERVICE_API_KEY env var
let serviceClient: KanApiClient | null = null;

export function getServiceClient(): KanApiClient {
  if (!serviceClient) {
    const apiKey = process.env.KAN_SERVICE_API_KEY;
    if (!apiKey) {
      throw new Error("KAN_SERVICE_API_KEY environment variable is required");
    }
    serviceClient = new KanApiClient(apiKey);
  }
  return serviceClient;
}

export { KanApiClient };
