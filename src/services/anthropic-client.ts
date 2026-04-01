import { claudeCode } from "ai-sdk-provider-claude-code";

/**
 * Claude Code AI SDK provider.
 * Routes through the Claude Code CLI, billing against your Max subscription.
 * Requires `claude login` on the host machine.
 */

/** Default model — uses Max subscription via Claude Code. */
const DEFAULT_MODEL = "sonnet";

/**
 * Get a model instance for use with generateText/generateObject.
 * @param modelId — Override the default model (e.g. 'haiku' for cheap classification).
 */
export function getModel(modelId?: string) {
  return claudeCode(modelId ?? DEFAULT_MODEL);
}
