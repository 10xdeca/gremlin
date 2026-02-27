# xdeca-pm-bot

Telegram bot for Kan.bn task management — full LLM agent with MCP tools. TypeScript + Grammy + Claude Haiku + SQLite (Drizzle ORM).

## Build & Run

```bash
npm run dev          # Development with tsx watch
npm run build        # TypeScript compile
npm run start        # Run compiled JS
npm run typecheck    # tsc --noEmit
```

## Architecture

Every user message flows through a Claude Haiku agent loop with access to Kan and Outline MCP tools:

```
Telegram Message → Grammy → Agent Loop (Claude Haiku + tools) → Response → Telegram
                                ├── Kan MCP tools (task management)
                                ├── Outline MCP tools (knowledge base)
                                ├── Playwright MCP tools (web browsing, optional)
                                └── Custom tools (DB config, sprint info, user mappings)
```

- **Grammy** for Telegram bot framework
- **@anthropic-ai/sdk** for Claude Haiku agent loop (all interactions) and vagueness evaluation (scheduler)
- **@modelcontextprotocol/sdk** for MCP client (spawns kan-mcp, outline-mcp, and optionally playwright-mcp as subprocesses)
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
- `mcp-servers/` — Bundled MCP server source (kan/, outline/)

## Deployment

This is the source code only. Deployment config is in `xdeca-infra/xdeca-pm-bot/`:

- `docker-compose.yml` builds from this source (rsynced from `xdeca-pm-bot/` to `xdeca-pm-bot/src/` on server)
- Secrets in `secrets.yaml` (SOPS-encrypted)
- Deploy: `./scripts/deploy-to.sh 34.116.110.7 xdeca-pm-bot` from xdeca-infra repo
- Server: GCP Compute Engine (e2-medium) at 34.116.110.7
- Logs: `ssh ubuntu@34.116.110.7 'docker logs -f xdeca-pm-bot'`

## Key Patterns

- ALL user messages (including /commands) route through the agent loop in `src/agent/agent-loop.ts`
- The agent has access to ~40 MCP tools (Kan + Outline) plus custom tools for DB config
- System prompt is context-aware: includes bot identity, workspace config, sprint status, team mappings, admin status
- Scheduler uses MCP client directly (no LLM) for deterministic reminder checks
- DB queries are async wrappers around synchronous Drizzle calls
- Reminders use a `(card_public_id, telegram_chat_id, reminder_type)` UNIQUE constraint to prevent duplicates
- Sprint planning window (days 1-2) gates certain reminder types

## Known Kan API Quirks

- **Card move requires `index`**: The Kan API returns 500 if you PUT to `/cards/:id` with `listPublicId` but without `index`. Fixed in `mcp-servers/packages/kan/index.js` — `kan_update_card` now defaults `index` to `0` when `list_id` is provided without an explicit index. (PR #33)
- Tool call logging was added at `src/agent/agent-loop.ts:98` to aid debugging MCP tool failures.

## Environment Variables

See `.env.example` for all required and optional variables. Key additions for the MCP-based architecture:

- `KAN_API_KEY` — Kan API key (replaces old `KAN_SERVICE_API_KEY`)
- `OUTLINE_API_KEY` — Outline wiki API key
- `OUTLINE_BASE_URL` — Outline API base URL
- `PLAYWRIGHT_ENABLED` — Set to `"true"` to enable web browsing tools (Playwright MCP server)
