import type { Api } from "grammy";
import type {
  Message,
  Task,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from "@a2a-js/sdk";
import { getA2AClient } from "./a2a-client.js";
import { evaluateSteering } from "./steering-evaluator.js";

/** Union of all event types yielded by sendMessageStream. */
type A2AStreamEvent = Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

const RESEARCH_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes max
const MAX_STEERING_ROUNDS = 3;

interface ResearchOptions {
  query: string;
  context?: string;
  chatId: number;
  messageThreadId?: number;
}

/**
 * Conduct a research session via A2A protocol.
 *
 * 1. Sends the initial research request via sendMessageStream()
 * 2. Processes SSE events, sending Telegram progress updates
 * 3. On input-required: evaluates via steering evaluator
 * 4. Sends steering feedback back for deep dives
 * 5. Returns the compiled final report
 */
export async function conductResearch(
  api: Api,
  options: ResearchOptions
): Promise<string> {
  const { query, context, chatId, messageThreadId } = options;
  const client = getA2AClient();

  const fullQuery = context ? `${query}\n\nAdditional context: ${context}` : query;

  // Track task/context IDs for multi-turn conversation
  let taskId: string | undefined;
  let contextId: string | undefined;
  let steeringRounds = 0;
  let finalReport = "";

  const sendProgress = (text: string) => {
    api
      .sendMessage(chatId, text, {
        parse_mode: "Markdown",
        ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      })
      .catch((err) => console.error("Failed to send progress:", err));
  };

  // Wrap the entire research session in a timeout (cleared on completion)
  let timeoutTimer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<string>((_, reject) => {
    timeoutTimer = setTimeout(
      () => reject(new Error("Research timed out after 2 minutes")),
      RESEARCH_TIMEOUT_MS
    );
  });

  const researchPromise = (async () => {
    // Initial request
    const stream = client.sendMessageStream({
      message: {
        messageId: crypto.randomUUID(),
        role: "user" as const,
        parts: [{ kind: "text" as const, text: fullQuery }],
        kind: "message" as const,
      },
    });

    const result = await processStream(stream, sendProgress, (tid, cid) => {
      taskId = tid;
      contextId = cid;
    });

    // If we got a final report directly, return it
    if (result.completed) {
      return result.report;
    }

    // Handle input-required checkpoints with steering
    let interimFindings = result.interimFindings;

    while (steeringRounds < MAX_STEERING_ROUNDS && interimFindings) {
      steeringRounds++;

      // Evaluate whether to accept or steer
      const steering = await evaluateSteering(query, interimFindings);

      if (steering.accept) {
        sendProgress("Compiling final report...");

        // Send acceptance to compile final report
        const acceptStream = client.sendMessageStream({
          message: {
            messageId: crypto.randomUUID(),
            role: "user" as const,
            parts: [{ kind: "text" as const, text: "compile final report" }],
            kind: "message" as const,
            taskId,
            contextId,
          },
        });

        const acceptResult = await processStream(acceptStream, sendProgress);
        return acceptResult.report;
      }

      // Send steering feedback
      sendProgress(`Investigating further...`);

      const steerStream = client.sendMessageStream({
        message: {
          messageId: crypto.randomUUID(),
          role: "user" as const,
          parts: [{ kind: "text" as const, text: steering.feedback }],
          kind: "message" as const,
          taskId,
          contextId,
        },
      });

      const steerResult = await processStream(steerStream, sendProgress);

      if (steerResult.completed) {
        return steerResult.report;
      }

      // Another input-required checkpoint
      interimFindings = steerResult.interimFindings;
    }

    // Exhausted steering rounds — request final compilation
    if (taskId) {
      sendProgress("Compiling final report...");

      const finalStream = client.sendMessageStream({
        message: {
          messageId: crypto.randomUUID(),
          role: "user" as const,
          parts: [{ kind: "text" as const, text: "compile final report" }],
          kind: "message" as const,
          taskId,
          contextId,
        },
      });

      const finalResult = await processStream(finalStream, sendProgress);
      return finalResult.report;
    }

    return interimFindings || "Research completed but no report was generated.";
  })();

  try {
    finalReport = await Promise.race([researchPromise, timeoutPromise]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Research session error:", errorMsg);
    finalReport = `Research could not be completed: ${errorMsg}`;
  } finally {
    clearTimeout(timeoutTimer!);
  }

  return finalReport;
}

interface StreamResult {
  completed: boolean;
  report: string;
  interimFindings: string;
}

/**
 * Process an A2A SSE stream, extracting status updates and artifacts.
 */
async function processStream(
  stream: AsyncIterable<A2AStreamEvent>,
  sendProgress: (text: string) => void,
  onIds?: (taskId: string, contextId: string) => void
): Promise<StreamResult> {
  let report = "";
  let interimFindings = "";
  let completed = false;

  for await (const event of stream) {
    if (event.kind === "task") {
      // Initial task creation — capture IDs
      onIds?.(event.id, event.contextId);
    } else if (event.kind === "message") {
      // Agent message — extract text as part of the report
      const text = getPartsText(event.parts);
      if (text) report = text;
    } else if (event.kind === "status-update") {
      const state = event.status.state;
      const messageText = getMessageText(event);

      if (state === "working" && messageText) {
        // Forward all working status messages as Telegram progress updates
        sendProgress(messageText.slice(0, 200));
      } else if (state === "input-required" && messageText) {
        interimFindings = messageText;
      } else if (state === "completed") {
        completed = true;
        if (messageText) report = messageText;
      } else if (state === "failed" && messageText) {
        report = `Research failed: ${messageText}`;
        completed = true;
      }

      // Capture task/context IDs from status events
      if (event.taskId && event.contextId) {
        onIds?.(event.taskId, event.contextId);
      }
    } else if (event.kind === "artifact-update") {
      const artifactText = getPartsText(event.artifact.parts);
      if (artifactText) report = artifactText;
    }
  }

  return { completed, report, interimFindings };
}

/** Extract text from a status update's message. */
function getMessageText(event: TaskStatusUpdateEvent): string {
  return getPartsText(event.status.message?.parts || []);
}

/** Extract concatenated text from an array of message parts. */
function getPartsText(parts: Array<{ kind: string; text?: string }>): string {
  return parts
    .filter((p) => p.kind === "text" && "text" in p)
    .map((p) => p.text ?? "")
    .join("\n");
}
