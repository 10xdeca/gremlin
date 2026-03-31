import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "../services/anthropic-client.js";

interface SteeringResult {
  /** Whether to accept the interim findings as-is. */
  accept: boolean;
  /** Feedback/steering for the research agent (if not accepting). */
  feedback: string;
}

const SteeringSchema = z.object({
  accept: z.boolean().describe("Whether to accept the interim findings"),
  feedback: z.string().describe("Specific areas to investigate further, or 'compile final report' if accepting"),
});

/**
 * Evaluate interim research findings and decide whether to accept
 * or steer the research agent for a deeper dive.
 */
export async function evaluateSteering(
  originalQuery: string,
  interimFindings: string
): Promise<SteeringResult> {
  try {
    const { object } = await generateObject({
      model: getModel(),
      schema: SteeringSchema,
      maxOutputTokens: 300,
      prompt: `You are evaluating interim research findings. Decide whether they adequately answer the original question, or whether the research agent should investigate specific areas further.

Original question: "${originalQuery}"

Interim findings:
${interimFindings.slice(0, 4000)}

Accept if:
- The findings clearly answer the question
- There's good coverage of the topic from multiple sources
- No obvious gaps in the information

Don't accept if:
- Key aspects of the question are unanswered
- The findings are too superficial
- Important context is missing that could be found with targeted searches`,
    });

    return object;
  } catch (error) {
    console.error("Steering evaluation failed:", error);
    // On error, accept what we have
    return { accept: true, feedback: "compile final report" };
  }
}
