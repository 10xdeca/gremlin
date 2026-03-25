#!/bin/bash
# Get a Claude OAuth refresh token for Gremlin
# Opens browser for login, captures the token via local callback server
#
# Usage: ./scripts/get-refresh-token.sh
# Output: Prints the refresh token to stdout

set -e

PORT=9876
CLIENT_ID="9d1c250a-e61b-44d9-88ed-5944d1962f5e"
REDIRECT_URI="http://localhost:${PORT}/callback"
TOKEN_URL="https://platform.claude.com/v1/oauth/token"
AUTHORIZE_URL="https://claude.ai/oauth/authorize"
SCOPE="user:inference user:profile"

# Generate PKCE code_verifier (64 random bytes, base64url-encoded)
CODE_VERIFIER=$(openssl rand -base64 48 | tr -d '=+/' | head -c 64)

# Generate code_challenge = SHA256(code_verifier), base64url-encoded
CODE_CHALLENGE=$(printf '%s' "$CODE_VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')

# Random state for CSRF protection
STATE=$(openssl rand -hex 16)

# Build authorization URL
AUTH_URL="${AUTHORIZE_URL}?client_id=${CLIENT_ID}&response_type=code&redirect_uri=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${REDIRECT_URI}'))")&code_challenge=${CODE_CHALLENGE}&code_challenge_method=S256&scope=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${SCOPE}'))")&state=${STATE}"

echo "Opening browser for Claude login..."
echo ""
open "$AUTH_URL"

# Start a minimal HTTP server to capture the callback
echo "Waiting for OAuth callback on port ${PORT}..."
echo ""

# Use Python to run a one-shot HTTP server that captures the auth code
python3 << PYEOF
import http.server
import urllib.parse

class CallbackHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/callback" and "code" in params:
            code = params["code"][0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<html><body><h1>Got it!</h1><p>You can close this tab.</p></body></html>")
            with open("/tmp/oauth_code", "w") as f:
                f.write(code)
        else:
            self.send_response(400)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            error = params.get("error", ["unknown"])[0]
            desc = params.get("error_description", [""])[0]
            self.wfile.write(f"<html><body><h1>Error</h1><p>{error}: {desc}</p></body></html>".encode())
            with open("/tmp/oauth_code", "w") as f:
                f.write("")

    def log_message(self, format, *args):
        pass

server = http.server.HTTPServer(("localhost", ${PORT}), CallbackHandler)
server.handle_request()
PYEOF

AUTH_CODE=$(cat /tmp/oauth_code)
rm -f /tmp/oauth_code

if [ -z "$AUTH_CODE" ]; then
    echo "ERROR: No auth code received. Login may have failed."
    exit 1
fi

echo ""
echo "Auth code received!"
echo ""

# Save exchange params so user can retry without re-logging in
EXCHANGE_SCRIPT="/tmp/exchange-token.sh"
cat > "$EXCHANGE_SCRIPT" << XEOF
#!/bin/bash
# Retry this until it works (auth code valid ~5 min)
curl -s -X POST '${TOKEN_URL}' \\
  -H 'Content-Type: application/json' \\
  -d '{"grant_type":"authorization_code","code":"${AUTH_CODE}","client_id":"${CLIENT_ID}","code_verifier":"${CODE_VERIFIER}","redirect_uri":"${REDIRECT_URI}"}' | python3 -m json.tool
XEOF
chmod +x "$EXCHANGE_SCRIPT"

echo "Exchanging (will retry up to 5 times with backoff)..."
echo ""

for i in 1 2 3 4 5; do
    RESPONSE=$(curl -s -X POST "$TOKEN_URL" \
        -H "Content-Type: application/json" \
        -d "{\"grant_type\":\"authorization_code\",\"code\":\"${AUTH_CODE}\",\"client_id\":\"${CLIENT_ID}\",\"code_verifier\":\"${CODE_VERIFIER}\",\"redirect_uri\":\"${REDIRECT_URI}\"}")

    REFRESH_TOKEN=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('refresh_token',''))" 2>/dev/null)

    if [ -n "$REFRESH_TOKEN" ]; then
        echo "============================================"
        echo "  Refresh token:"
        echo "============================================"
        echo "$REFRESH_TOKEN"
        echo "============================================"
        rm -f "$EXCHANGE_SCRIPT"
        exit 0
    fi

    if echo "$RESPONSE" | grep -q "rate_limit"; then
        WAIT=$((i * 15))
        echo "Rate limited. Waiting ${WAIT}s... (attempt $i/5)"
        sleep "$WAIT"
    else
        echo "ERROR: $RESPONSE"
        exit 1
    fi
done

echo ""
echo "Still rate limited. The auth code may still be valid — keep trying manually:"
echo "  /tmp/exchange-token.sh"
