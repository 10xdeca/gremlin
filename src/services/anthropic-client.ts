import Anthropic from "@anthropic-ai/sdk";
import { getOAuthToken, saveOAuthToken } from "../db/queries.js";

const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"; // Claude Code CLI
const REFRESH_BUFFER_MS = 60 * 60 * 1000; // Refresh 1 hour before expiry

let cachedClient: Anthropic | null = null;
let tokenExpiresAt = 0;
let currentRefreshToken: string | null = null; // Refresh tokens are single-use

interface TokenResponse {
  access_token: string;
  refresh_token: string; // New single-use refresh token
  expires_in: number; // seconds (typically 28800 = 8h)
}

/**
 * Get an Anthropic client authenticated via Claude Max OAuth.
 * Caches the client and auto-refreshes the access token before expiry.
 * Refresh tokens are single-use — each refresh returns a new one.
 * Persists the latest refresh token to SQLite so it survives restarts.
 */
export async function getAnthropicClient(): Promise<Anthropic> {
  if (cachedClient && Date.now() < tokenExpiresAt - REFRESH_BUFFER_MS) {
    return cachedClient;
  }

  // Try in-memory → DB → env var
  let refreshToken = currentRefreshToken;
  if (!refreshToken) {
    try {
      refreshToken = await getOAuthToken("claude_refresh");
    } catch (e) {
      console.warn("Failed to read refresh token from DB, falling back to env var:", e);
    }
  }
  refreshToken ??= process.env.CLAUDE_REFRESH_TOKEN ?? null;

  if (!refreshToken) {
    throw new Error("No refresh token available (checked DB and CLAUDE_REFRESH_TOKEN env var)");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OAuth token refresh failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as TokenResponse;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  currentRefreshToken = data.refresh_token;

  // Persist the new single-use refresh token to DB (expiresAt tracks access token expiry for cache invalidation)
  try {
    await saveOAuthToken("claude_refresh", data.refresh_token, tokenExpiresAt);
  } catch (e) {
    console.warn("Failed to persist refresh token to DB:", e);
  }

  cachedClient = new Anthropic({
    apiKey: null as unknown as string,
    authToken: data.access_token,
    defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
  });

  console.log(
    `Anthropic OAuth token refreshed, expires in ${Math.round(data.expires_in / 3600)}h`
  );

  return cachedClient;
}
