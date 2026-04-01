import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "./anthropic-client.js";

interface TaskInfo {
  title: string;
  description: string | null;
  listName: string;
}

interface VaguenessResult {
  isVague: boolean;
  reason: string | null;
}

// Cache to avoid repeated API calls for the same task
const cache = new Map<string, { result: VaguenessResult; timestamp: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function getCacheKey(task: TaskInfo): string {
  return `${task.title}::${task.description || ""}`;
}

const VaguenessSchema = z.object({
  isVague: z.boolean().describe("Whether the task is too vague to start working on"),
  reason: z.string().nullable().describe("Brief reason if vague, null if clear"),
});

export async function evaluateTaskVagueness(task: TaskInfo): Promise<VaguenessResult> {
  const cacheKey = getCacheKey(task);
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.result;
  }

  try {
    const { object } = await generateObject({
      model: getModel(),
      schema: VaguenessSchema,
      maxOutputTokens: 150,
      prompt: `Evaluate if this task is clear enough for someone to start working on it.

Task title: "${task.title}"
Description: ${task.description ? `"${task.description}"` : "(none)"}
List: ${task.listName}

A task is vague if:
- It's unclear what the deliverable is
- Missing key details needed to start work
- Too broad without specifics

A task is NOT vague if:
- The title is self-explanatory (e.g., "Fix typo in README")
- It's a well-known type of task (e.g., "Weekly standup notes")
- The context from the list name makes it clear`,
    });

    const result: VaguenessResult = object;

    // Cache the result
    cache.set(cacheKey, { result, timestamp: Date.now() });

    return result;
  } catch (error) {
    console.error("Error evaluating task vagueness:", error);
    // On error, fall back to simple heuristic
    const descLength = task.description?.trim().length || 0;
    return {
      isVague: descLength < 30 && task.title.length < 20,
      reason: null,
    };
  }
}

// Clean old cache entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CACHE_TTL_MS) {
      cache.delete(key);
    }
  }
}, 60 * 60 * 1000); // Clean every hour
