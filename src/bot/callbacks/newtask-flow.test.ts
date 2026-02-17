import { describe, it, expect, vi } from "vitest";
import {
  storeFlow,
  getFlow,
  deleteFlow,
  buildBoardKeyboard,
  buildListKeyboard,
  buildAssigneeKeyboard,
} from "./newtask-flow.js";

const baseFlowData = {
  title: "Fix the login page",
  chatId: 123,
  workspacePublicId: "ws123",
  mentionsProvided: false,
  selectedMemberIds: [] as string[],
  selectedMemberNames: [] as string[],
  unresolvedMentions: [] as string[],
  step: "board" as const,
};

describe("newtask flow store", () => {
  it("stores and retrieves a flow", () => {
    const id = storeFlow(baseFlowData);
    const result = getFlow(id);

    expect(result).toBeDefined();
    expect(result!.title).toBe("Fix the login page");
    expect(result!.id).toBe(id);
    expect(result!.chatId).toBe(123);
    expect(result!.step).toBe("board");
  });

  it("returns unique IDs for different flows", () => {
    const id1 = storeFlow(baseFlowData);
    const id2 = storeFlow(baseFlowData);

    expect(id1).not.toBe(id2);
  });

  it("returns undefined for non-existent ID", () => {
    expect(getFlow("nonexistent")).toBeUndefined();
  });

  it("deletes a flow", () => {
    const id = storeFlow(baseFlowData);
    expect(getFlow(id)).toBeDefined();

    deleteFlow(id);
    expect(getFlow(id)).toBeUndefined();
  });

  it("expires flows after 10-minute TTL", () => {
    vi.useFakeTimers();
    try {
      const id = storeFlow(baseFlowData);
      expect(getFlow(id)).toBeDefined();

      // Advance past the 10-minute TTL
      vi.advanceTimersByTime(11 * 60 * 1000);
      expect(getFlow(id)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns flow within TTL", () => {
    vi.useFakeTimers();
    try {
      const id = storeFlow(baseFlowData);

      // 5 minutes - still within TTL
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(getFlow(id)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves mentions data in stored flow", () => {
    const id = storeFlow({
      ...baseFlowData,
      mentionsProvided: true,
      selectedMemberIds: ["m1", "m2"],
      selectedMemberNames: ["@nick", "@alice"],
      unresolvedMentions: ["bob"],
    });

    const flow = getFlow(id);
    expect(flow!.mentionsProvided).toBe(true);
    expect(flow!.selectedMemberIds).toEqual(["m1", "m2"]);
    expect(flow!.selectedMemberNames).toEqual(["@nick", "@alice"]);
    expect(flow!.unresolvedMentions).toEqual(["bob"]);
  });
});

describe("member toggle logic", () => {
  it("allows mutating selectedMemberIds on stored flow", () => {
    const id = storeFlow(baseFlowData);
    const flow = getFlow(id)!;

    // Simulate toggle ON
    flow.selectedMemberIds.push("m1");
    flow.selectedMemberNames.push("Nick");

    const retrieved = getFlow(id)!;
    expect(retrieved.selectedMemberIds).toEqual(["m1"]);
    expect(retrieved.selectedMemberNames).toEqual(["Nick"]);

    // Simulate toggle OFF
    const idx = retrieved.selectedMemberIds.indexOf("m1");
    retrieved.selectedMemberIds.splice(idx, 1);
    retrieved.selectedMemberNames.splice(idx, 1);

    expect(getFlow(id)!.selectedMemberIds).toEqual([]);
    expect(getFlow(id)!.selectedMemberNames).toEqual([]);
  });
});

describe("keyboard builders", () => {
  it("builds board keyboard with cancel button", () => {
    const boards = [
      { publicId: "b1", name: "Sprint Board" },
      { publicId: "b2", name: "Backlog Board" },
    ];

    const keyboard = buildBoardKeyboard("flow1", boards);
    const rows = keyboard.inline_keyboard;

    expect(rows).toHaveLength(3); // 2 boards + cancel
    expect(rows[0][0].text).toBe("Sprint Board");
    expect(rows[0][0].callback_data).toBe("nt:b:flow1:0");
    expect(rows[1][0].text).toBe("Backlog Board");
    expect(rows[1][0].callback_data).toBe("nt:b:flow1:1");
    expect(rows[2][0].text).toBe("Cancel");
    expect(rows[2][0].callback_data).toBe("nt:x:flow1");
  });

  it("builds list keyboard with cancel button", () => {
    const lists = [
      { publicId: "l1", name: "To Do" },
      { publicId: "l2", name: "In Progress" },
    ];

    const keyboard = buildListKeyboard("flow1", lists);
    const rows = keyboard.inline_keyboard;

    expect(rows).toHaveLength(3); // 2 lists + cancel
    expect(rows[0][0].text).toBe("To Do");
    expect(rows[0][0].callback_data).toBe("nt:l:flow1:0");
    expect(rows[1][0].text).toBe("In Progress");
    expect(rows[1][0].callback_data).toBe("nt:l:flow1:1");
  });

  it("builds assignee keyboard with no selections", () => {
    const members = [
      { publicId: "m1", name: "Nick" },
      { publicId: "m2", name: "Alice" },
    ];

    const keyboard = buildAssigneeKeyboard("flow1", members, []);
    const rows = keyboard.inline_keyboard;

    expect(rows).toHaveLength(3); // 2 members + action row
    expect(rows[0][0].text).toBe("Nick");
    expect(rows[0][0].callback_data).toBe("nt:m:flow1:0");
    expect(rows[1][0].text).toBe("Alice");
    expect(rows[1][0].callback_data).toBe("nt:m:flow1:1");

    // Action row: Done, Skip, Cancel
    const actionRow = rows[2];
    expect(actionRow).toHaveLength(3);
    expect(actionRow[0].text).toBe("Done");
    expect(actionRow[0].callback_data).toBe("nt:ok:flow1");
    expect(actionRow[1].text).toBe("Skip");
    expect(actionRow[1].callback_data).toBe("nt:sk:flow1");
    expect(actionRow[2].text).toBe("Cancel");
    expect(actionRow[2].callback_data).toBe("nt:x:flow1");
  });

  it("shows checkmarks and count for selected members", () => {
    const members = [
      { publicId: "m1", name: "Nick" },
      { publicId: "m2", name: "Alice" },
      { publicId: "m3", name: "Bob" },
    ];

    const keyboard = buildAssigneeKeyboard("flow1", members, ["m1", "m3"]);
    const rows = keyboard.inline_keyboard;

    expect(rows[0][0].text).toBe("✓ Nick");
    expect(rows[1][0].text).toBe("Alice");
    expect(rows[2][0].text).toBe("✓ Bob");

    // Done button shows count
    const actionRow = rows[3];
    expect(actionRow[0].text).toBe("Done (2)");
  });

  it("callback data stays under 64 bytes", () => {
    const boards = Array.from({ length: 20 }, (_, i) => ({
      publicId: `board${i}`,
      name: `Board ${i}`,
    }));

    const keyboard = buildBoardKeyboard("abcdefghij", boards);
    for (const row of keyboard.inline_keyboard) {
      for (const button of row) {
        if (button.callback_data) {
          expect(button.callback_data.length).toBeLessThanOrEqual(64);
        }
      }
    }
  });
});
