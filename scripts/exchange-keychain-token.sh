#!/bin/bash
# Exchange Claude Code's keychain refresh token for a new one (for gremlin)
# WARNING: This invalidates your Claude Code session — you'll need to re-login
#
# Usage: ./scripts/exchange-keychain-token.sh
# Run this when the rate limit has cooled off (wait ~1 hour after last attempt)

set -e

TOKEN_URL="https://platform.claude.com/v1/oauth/token"
CLIENT_ID="9d1c250a-e61b-44d9-88ed-5944d1962f5e"

echo "Reading refresh token from macOS keychain..."
REFRESH_TOKEN=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['claudeAiOauth']['refreshToken'])")

if [ -z "$REFRESH_TOKEN" ]; then
    echo "ERROR: Could not read token from keychain"
    exit 1
fi

echo "Exchanging token..."
RESPONSE=$(curl -s -X POST "$TOKEN_URL" \
    -H "Content-Type: application/json" \
    -d "{\"grant_type\":\"refresh_token\",\"refresh_token\":\"${REFRESH_TOKEN}\",\"client_id\":\"${CLIENT_ID}\"}")

NEW_REFRESH=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('refresh_token',''))" 2>/dev/null)

if [ -z "$NEW_REFRESH" ]; then
    echo "FAILED — probably still rate limited. Try again later."
    echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
    exit 1
fi

echo ""
echo "============================================"
echo "  Got it! Refresh token for gremlin:"
echo "============================================"
echo ""
echo "$NEW_REFRESH"
echo ""
echo "Your Claude Code session is now invalidated."
echo "Next time you run 'claude', it will ask you to log in again."
echo ""
echo "To inject into gremlin on the server, run:"
echo "  ssh 149.118.69.221 \"docker exec gremlin node -e \\\"const db=require('better-sqlite3')('/app/data/gremlin.db'); db.prepare('INSERT OR REPLACE INTO oauth_tokens (key, token, expires_at) VALUES (?, ?, 0)').run('claude_refresh', '$NEW_REFRESH'); console.log('done');\\\"\""
