import { createAnthropic } from "@ai-sdk/anthropic";

/**
 * Anthropic provider using Max subscription OAuth token.
 *
 * Uses CLAUDE_CODE_OAUTH_TOKEN (long-lived, from `claude setup-token`)
 * with the OAuth beta header for direct API access — no CLI spawn overhead.
 * Falls back to ANTHROPIC_API_KEY for standard API key auth.
 */
const anthropic = createAnthropic({
  ...(process.env.CLAUDE_CODE_OAUTH_TOKEN
    ? {
        authToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        headers: { "anthropic-beta": "oauth-2025-04-20" },
      }
    : {}),
});

/** Default model. */
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/**
 * Get a model instance for use with generateText/generateObject.
 * @param modelId — Override the default model.
 */
export function getModel(modelId?: string) {
  return anthropic(modelId ?? DEFAULT_MODEL);
}
