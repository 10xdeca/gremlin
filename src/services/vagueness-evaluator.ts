import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

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

export async function evaluateTaskVagueness(task: TaskInfo): Promise<VaguenessResult> {
  const cacheKey = getCacheKey(task);
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.result;
  }

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-20250514",
      max_tokens: 150,
      messages: [
        {
          role: "user",
          content: `Evaluate if this task is clear enough for someone to start working on it.

Task title: "${task.title}"
Description: ${task.description ? `"${task.description}"` : "(none)"}
List: ${task.listName}

Respond with JSON only: {"isVague": true/false, "reason": "brief reason if vague, null if clear"}

A task is vague if:
- It's unclear what the deliverable is
- Missing key details needed to start work
- Too broad without specifics

A task is NOT vague if:
- The title is self-explanatory (e.g., "Fix typo in README")
- It's a well-known type of task (e.g., "Weekly standup notes")
- The context from the list name makes it clear`,
        },
      ],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("Failed to parse vagueness response:", text);
      return { isVague: false, reason: null };
    }

    const result = JSON.parse(jsonMatch[0]) as VaguenessResult;

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
