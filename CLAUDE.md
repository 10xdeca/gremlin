# gremlin

Telegram bot for Kan.bn task management — full LLM agent with MCP tools. TypeScript + Grammy + Claude Sonnet + SQLite (Drizzle ORM).

## Build & Run

```bash
npm run dev          # Development with tsx watch
npm run build        # TypeScript compile
npm run start        # Run compiled JS
npm run typecheck    # tsc --noEmit
npm test             # Run tests (unit + integration + smoke)
npm run test:watch   # Watch mode
npm run test:coverage # With coverage report
```

## Architecture

Every user message flows through a Claude Sonnet agent loop with access to Kan and Outline MCP tools:

```
Telegram Message → Grammy → Agent Loop (Claude Sonnet + tools) → Response → Telegram
                                ├── Kan MCP tools (task management)
                                ├── Outline MCP tools (knowledge base)
                                ├── Radicale MCP tools (calendar/contacts, optional)
                                ├── Playwright MCP tools (web browsing, optional)
                                └── Custom tools (DB config, sprint info, user mappings)
```

- **Grammy** for Telegram bot framework
- **@anthropic-ai/sdk** for Claude Sonnet agent loop (all interactions) and vagueness evaluation (scheduler)
- **@modelcontextprotocol/sdk** for MCP client (spawns kan-mcp, outline-mcp, radicale-mcp, and optionally playwright-mcp as subprocesses)
- **better-sqlite3** + **Drizzle ORM** for local SQLite storage
- **node-cron** for scheduled reminder checks (deterministic, no LLM)
- **Conversation history**: In-memory sliding window per chat (last 20 messages, 30min TTL)
- DB migrations run automatically on startup in `src/db/client.ts`

### Key Directories

- `src/agent/` — Agent loop, MCP manager, tool registry, system prompt, conversation history
- `src/tools/` — Custom tools (chat-config, user-mapping, sprint-info, bot-identity)
- `src/scheduler/` — Cron-based reminder checks (uses MCP client directly, no LLM)
- `src/services/` — Bot identity cache, vagueness evaluator
- `src/db/` — Schema, queries, SQLite client
- `src/utils/` — Sprint calculations, @mention parsing
- `mcp-servers/` — Bundled MCP server source (kan/, outline/, radicale/)

## Deployment

This is the source code only. Deployment config is in `xdeca-infra/gremlin/`:

- `docker-compose.yml` builds from this source (rsynced from `gremlin/` to `gremlin/src/` on server)
- Secrets in `secrets.yaml` (SOPS-encrypted)
- Deploy: `./scripts/deploy-to.sh 34.116.110.7 gremlin` from xdeca-infra repo
- Server: GCP Compute Engine (e2-medium) at 34.116.110.7
- Logs: `ssh ubuntu@34.116.110.7 'docker logs -f gremlin'`

## Key Patterns

- ALL user messages (including /commands) route through the agent loop in `src/agent/agent-loop.ts`
- The agent has access to ~60 MCP tools (Kan + Outline + Radicale) plus custom tools for DB config
- System prompt is context-aware: includes bot identity, workspace config, sprint status, team mappings, admin status
- Scheduler uses MCP client directly (no LLM) for deterministic reminder checks
- DB queries are async wrappers around synchronous Drizzle calls
- Reminders use a `(card_public_id, telegram_chat_id, reminder_type)` UNIQUE constraint to prevent duplicates
- Sprint planning window (days 1-2) gates certain reminder types

## Known Kan API Quirks

- **Card move requires `index`**: The Kan API returns 500 if you PUT to `/cards/:id` with `listPublicId` but without `index`. Fixed in `mcp-servers/packages/kan/index.js` — `kan_update_card` now defaults `index` to `0` when `list_id` is provided without an explicit index. (PR #33)
- Tool call logging was added at `src/agent/agent-loop.ts:98` to aid debugging MCP tool failures.

## Testing

Three layers of automated tests run in CI (typecheck → test → build):

- **Unit tests** (`src/**/*.test.ts`) — Sprint utils, timezone, mentions, DB queries, conversation history
- **Integration tests** (`src/agent/agent-loop.integration.test.ts`) — Full agent loop pipeline with mocked Claude API and MCP tools. Tests tool call routing, error handling, auth failures, max rounds, image handling.
- **Smoke tests** (`src/smoke.test.ts`) — Verifies all modules import cleanly, DB schema applies, system prompt builds, custom tools register, and .env.example is up to date.

## Health Check

A lightweight HTTP health server runs on port 8080 (configurable via `HEALTH_PORT`):

- `GET /health` — Returns component status (bot polling, MCP servers, auth). Returns 200 for healthy/degraded, 503 for unhealthy.
- `GET /version` — Returns app version and deployed git SHA.

The Dockerfile includes a `HEALTHCHECK` directive and the deploy workflow verifies the health endpoint post-deploy.

## Versioning

Uses [release-please](https://github.com/googleapis/release-please) for automated semantic versioning:

- Conventional commits on `main` trigger release-please to create a release PR
- Merging the release PR bumps `package.json` version, generates `CHANGELOG.md`, and creates a git tag `vX.Y.Z`
- Workflow: `.github/workflows/release.yml`

## Environment Variables

See `.env.example` for all required and optional variables. Key additions for the MCP-based architecture:

- `KAN_API_KEY` — Kan API key (replaces old `KAN_SERVICE_API_KEY`)
- `OUTLINE_API_KEY` — Outline wiki API key
- `OUTLINE_BASE_URL` — Outline API base URL
- `RADICALE_URL` — CalDAV/CardDAV server URL
- `RADICALE_USERNAME` — Radicale username
- `RADICALE_PASSWORD` — Radicale password (required to enable Radicale MCP server)
- `RADICALE_CALENDAR_OWNER` — Optional: access another user's calendars
- `GITHUB_TOKEN` — Fine-grained PAT with `contents:read` scope (required to enable code reading tools)
- `GITHUB_REPO` — Default repo for code reading (default: `10xdeca/gremlin`)
- `PLAYWRIGHT_ENABLED` — Set to `"true"` to enable web browsing tools (Playwright MCP server)
- `HEALTH_PORT` — Health check server port (default: 8080)
- `DEPLOY_SHA` — Git SHA of deployed commit (set by CI)
