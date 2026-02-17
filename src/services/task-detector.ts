import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

export interface TaskDetectionResult {
  isTask: boolean;
  title: string;
  isInfrastructure: boolean;
  confidence: "low" | "medium" | "high";
  /** True for explicit requests like "please add a task for...", "create a task..." */
  isDirectRequest: boolean;
}

// Per-chat cooldown to avoid spamming LLM calls
const cooldowns = new Map<number, number>();
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Guards whether we should even bother checking a message for task intent.
 * Returns false (skip) for commands, short messages, bot messages, and cooldowns.
 */
export function shouldCheckMessage(
  chatId: number,
  text: string,
  isFromBot: boolean
): boolean {
  // Skip bot messages
  if (isFromBot) return false;

  // Skip commands
  if (text.startsWith("/")) return false;

  // Skip short messages
  if (text.length < 20) return false;

  // Per-chat cooldown
  const lastCheck = cooldowns.get(chatId);
  if (lastCheck && Date.now() - lastCheck < COOLDOWN_MS) {
    return false;
  }

  return true;
}

/** Records a cooldown for a chat (called after making an LLM check) */
export function recordCooldown(chatId: number): void {
  cooldowns.set(chatId, Date.now());
}

/**
 * Calls Claude Haiku to classify whether a message contains a task intent.
 */
export async function detectTask(messageText: string): Promise<TaskDetectionResult> {
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `Analyze this chat message and determine if it contains a task or action item.

Message: "${messageText}"

Respond with JSON only:
{
  "isTask": true/false,
  "title": "clean imperative title for the task (e.g. 'Update CI pipeline')",
  "isInfrastructure": true/false,
  "confidence": "low"/"medium"/"high",
  "isDirectRequest": true/false
}

Rules:
- isTask: true if the message suggests something that should be done
- title: extract a clean, imperative task title (start with a verb). If not a task, use empty string.
- isInfrastructure: true if the task relates to CI/CD, deployment, servers, DevOps, monitoring, cloud infrastructure, or developer tooling
- confidence: how confident you are this is a real task (not just discussion)
- isDirectRequest: true ONLY if the person is explicitly asking to create/add a task (e.g. "please add a task for...", "create a task to...", "add a card for...", "can you make a task..."). False for implicit suggestions like "I think we should..." or "We need to..."

Examples of direct requests (isDirectRequest: true):
- "please add a task to fix the login page"
- "create a task for updating the docs"
- "add a card to migrate the database"

Examples of implicit suggestions (isDirectRequest: false):
- "I think we should update the CI pipeline"
- "We need to fix the login page"
- "someone should look into the memory leak"
- "it would be good to add tests"`,
        },
      ],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("Failed to parse task detection response:", text);
      return { isTask: false, title: "", isInfrastructure: false, confidence: "low", isDirectRequest: false };
    }

    return JSON.parse(jsonMatch[0]) as TaskDetectionResult;
  } catch (error) {
    console.error("Error detecting task:", error);
    return { isTask: false, title: "", isInfrastructure: false, confidence: "low", isDirectRequest: false };
  }
}
