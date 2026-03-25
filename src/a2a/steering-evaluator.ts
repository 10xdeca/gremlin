import { getAnthropicClient } from "../services/anthropic-client.js";

interface SteeringResult {
  /** Whether to accept the interim findings as-is. */
  accept: boolean;
  /** Feedback/steering for the research agent (if not accepting). */
  feedback: string;
}

/**
 * Evaluate interim research findings and decide whether to accept
 * or steer the research agent for a deeper dive.
 *
 * Uses Claude Haiku for speed and cost — same pattern as vagueness-evaluator.
 */
export async function evaluateSteering(
  originalQuery: string,
  interimFindings: string
): Promise<SteeringResult> {
  try {
    const anthropic = await getAnthropicClient();
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: `You are evaluating interim research findings. Decide whether they adequately answer the original question, or whether the research agent should investigate specific areas further.

Original question: "${originalQuery}"

Interim findings:
${interimFindings.slice(0, 4000)}

Respond with JSON only: {"accept": true/false, "feedback": "specific areas to investigate further, or 'compile final report' if accepting"}

Accept if:
- The findings clearly answer the question
- There's good coverage of the topic from multiple sources
- No obvious gaps in the information

Don't accept if:
- Key aspects of the question are unanswered
- The findings are too superficial
- Important context is missing that could be found with targeted searches`,
        },
      ],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("Failed to parse steering response:", text);
      return { accept: true, feedback: "compile final report" };
    }

    return JSON.parse(jsonMatch[0]) as SteeringResult;
  } catch (error) {
    console.error("Steering evaluation failed:", error);
    // On error, accept what we have
    return { accept: true, feedback: "compile final report" };
  }
}
