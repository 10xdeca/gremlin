import { A2AClient } from "@a2a-js/sdk/client";

let cachedClient: A2AClient | null = null;

/**
 * Get the A2A client for the research agent.
 * Lazily creates and caches the client from RESEARCH_AGENT_URL env var.
 */
export function getA2AClient(): A2AClient {
  if (cachedClient) return cachedClient;

  const url = process.env.RESEARCH_AGENT_URL;
  if (!url) {
    throw new Error("RESEARCH_AGENT_URL environment variable is required");
  }

  cachedClient = new A2AClient(url);
  console.log(`A2A client initialized for research agent at ${url}`);
  return cachedClient;
}
