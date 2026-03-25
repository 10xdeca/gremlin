import { A2AClient } from "@a2a-js/sdk/client";

let cachedClient: A2AClient | null = null;

/**
 * Get the A2A client for the research agent.
 * Lazily creates and caches the client from RESEARCH_AGENT_URL env var.
 *
 * Uses A2AClient.fromCardUrl() which fetches the agent card on first call
 * to discover the agent's capabilities and service endpoint.
 */
export async function getA2AClient(): Promise<A2AClient> {
  if (cachedClient) return cachedClient;

  const url = process.env.RESEARCH_AGENT_URL;
  if (!url) {
    throw new Error("RESEARCH_AGENT_URL environment variable is required");
  }

  cachedClient = await A2AClient.fromCardUrl(url);
  console.log(`A2A client initialized for research agent at ${url}`);
  return cachedClient;
}
