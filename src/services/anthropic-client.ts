import Anthropic from "@anthropic-ai/sdk";
import { getOAuthToken, saveOAuthToken } from "../db/queries.js";
import { alertAdmins } from "./admin-alerts.js";

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"; // Claude Code CLI
const REFRESH_BUFFER_MS = 60 * 60 * 1000; // Refresh 1 hour before expiry

/** When true, using a static API key — no OAuth refresh needed. */
const USE_API_KEY = !!process.env.ANTHROPIC_API_KEY;

let cachedClient: Anthropic | null = null;
let tokenExpiresAt = 0;
let currentRefreshToken: string | null = null; // Refresh tokens are single-use
let lastSuccessfulRefresh = 0;
let lastRefreshError: string | null = null;

interface TokenResponse {
  access_token: string;
  refresh_token: string; // New single-use refresh token
  expires_in: number; // seconds (typically 28800 = 8h)
}

export interface TokenHealth {
  status: "healthy" | "expired" | "error" | "unknown";
  lastRefresh: number; // epoch ms, 0 if never refreshed
  expiresAt: number; // epoch ms, 0 if unknown
  error?: string;
}

/** Returns current token health status for diagnostics and health checks. */
export function getTokenHealth(): TokenHealth {
  if (USE_API_KEY) {
    return {
      status: "healthy",
      lastRefresh: lastSuccessfulRefresh,
      expiresAt: tokenExpiresAt,
    };
  }

  if (lastRefreshError) {
    return {
      status: "error",
      lastRefresh: lastSuccessfulRefresh,
      expiresAt: tokenExpiresAt,
      error: lastRefreshError,
    };
  }

  if (lastSuccessfulRefresh === 0) {
    return {
      status: "unknown",
      lastRefresh: 0,
      expiresAt: 0,
    };
  }

  if (Date.now() >= tokenExpiresAt) {
    return {
      status: "expired",
      lastRefresh: lastSuccessfulRefresh,
      expiresAt: tokenExpiresAt,
    };
  }

  return {
    status: "healthy",
    lastRefresh: lastSuccessfulRefresh,
    expiresAt: tokenExpiresAt,
  };
}

/** Force the next getAnthropicClient() call to re-authenticate. */
export function invalidateCachedClient(): void {
  cachedClient = null;
  tokenExpiresAt = 0;
}

/**
 * Classify an OAuth refresh error by HTTP status.
 * Returns true if the error is an auth failure (unrecoverable).
 */
function isAuthError(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * Get an Anthropic client authenticated via Claude Max OAuth.
 * Caches the client and auto-refreshes the access token before expiry.
 * Refresh tokens are single-use — each refresh returns a new one.
 * Persists the latest refresh token to SQLite so it survives restarts.
 *
 * On failure, classifies errors and alerts admins:
 * - 401/403: Auth failure (token revoked/invalid) → "token_auth" alert
 * - Other HTTP/network errors: Transient failure → "token_network" alert
 */
export async function getAnthropicClient(): Promise<Anthropic> {
  // API key mode: no OAuth dance, no token expiry to manage
  if (USE_API_KEY) {
    if (!cachedClient) {
      cachedClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
      lastSuccessfulRefresh = Date.now();
      lastRefreshError = null;
      // Never expires — set far-future sentinel
      tokenExpiresAt = Date.now() + 365 * 24 * 60 * 60 * 1000;
      console.log("Anthropic client initialized with API key");
    }
    return cachedClient;
  }

  // OAuth mode: refresh access token before expiry
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
    const msg = "No refresh token available (checked DB and CLAUDE_REFRESH_TOKEN env var)";
    lastRefreshError = msg;
    throw new Error(msg);
  }

  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });
  } catch (err) {
    // Network error — endpoint unreachable
    const msg = `OAuth token refresh network error: ${err instanceof Error ? err.message : String(err)}`;
    console.error(msg);
    lastRefreshError = msg;
    alertAdmins(
      "token_network",
      `Failed to reach Anthropic token endpoint.\n\n\`${err instanceof Error ? err.message : String(err)}\``
    );
    throw new Error(msg);
  }

  if (!res.ok) {
    const body = await res.text();
    const truncatedBody = body.length > 200 ? body.slice(0, 200) + "…" : body;

    if (isAuthError(res.status)) {
      const msg = `OAuth refresh token invalid (${res.status}): ${truncatedBody}`;
      console.error(msg);
      lastRefreshError = msg;
      alertAdmins(
        "token_auth",
        `Refresh token rejected by Anthropic (HTTP ${res.status}).\n\nThis likely means the token was revoked, the subscription lapsed, or the single-use token was already consumed without being persisted.\n\n\`${truncatedBody}\``
      );
      throw new Error(msg);
    }

    // Other HTTP error (5xx, rate limit, etc.) — transient
    const msg = `OAuth token refresh failed (${res.status}): ${truncatedBody}`;
    console.error(msg);
    lastRefreshError = msg;
    alertAdmins(
      "token_network",
      `Token refresh failed with HTTP ${res.status}.\n\n\`${truncatedBody}\``
    );
    throw new Error(msg);
  }

  const data = (await res.json()) as TokenResponse;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  currentRefreshToken = data.refresh_token;
  lastSuccessfulRefresh = Date.now();
  lastRefreshError = null;

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
