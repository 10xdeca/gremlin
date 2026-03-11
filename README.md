# gremlin

Telegram bot for [Kan.bn](https://tasks.xdeca.com) task management — full LLM agent with MCP tools. TypeScript + [grammY](https://grammy.dev) + Claude Sonnet + SQLite (Drizzle ORM).

## How It Works

Every user message flows through a Claude Sonnet agent loop with access to Kan and Outline MCP tools. There are no hardcoded slash commands — the bot understands natural language and uses tools to fulfill requests.

```
Telegram Message → grammY → Agent Loop (Claude Sonnet + tools) → Response → Telegram
                                ├── Kan MCP tools (task management)
                                ├── Outline MCP tools (knowledge base)
                                └── Custom tools (DB config, sprint info, user mappings)
```

The agent has access to ~40 MCP tools (Kan + Outline) plus custom tools for managing chat configuration, user mappings, sprint info, standups, and bot identity. The system prompt is context-aware: it includes bot identity, workspace config, sprint status, team mappings, and admin status.

## Features

- **Task management** — create, update, assign, comment on, and complete Kan tasks via natural language
- **Knowledge base** — search and reference the Outline wiki
- **Automatic reminders** — cron-based checks for overdue, stale, vague, and unassigned tasks
- **Async daily standups** — configurable prompt/summary/nudge times per chat with AI-generated summaries
- **Bot identity** — the bot can be given a name and personality via a naming ceremony
- **Conversation history** — in-memory sliding window per chat (last 20 messages, 30min TTL)

## Automatic Reminders

| Reminder | Frequency | When |
|----------|-----------|------|
| Overdue tasks | Daily | Always |
| Stale tasks (in progress >14 days) | Every 2 days | Always |
| Unassigned tasks | Every 2 days | Always |
| Vague tasks (AI-evaluated) | Daily | Sprint days 1-2 |
| Missing due dates | Daily | Sprint days 1-2 |
| Members with no tasks | Daily | Sprint days 1-2 |

## Daily Standups

The bot supports async daily standups per chat:

- **Prompt** — posts a standup prompt at a configured hour (default 9am)
- **Nudge** — DMs non-responders at an optional nudge hour
- **Summary** — AI-generated summary posted at a configured hour (default 5pm)
- Skips weekends and sprint break days by default
- Configurable timezone per chat

## Environment Variables

See `.env.example` for all required and optional variables.

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token from @BotFather |
| `KAN_API_KEY` | Yes | API key for Kan.bn |
| `OUTLINE_API_KEY` | Yes | Outline wiki API key |
| `OUTLINE_BASE_URL` | Yes | Outline API base URL |
| `CLAUDE_REFRESH_TOKEN` | Yes | Claude Max OAuth refresh token |
| `KAN_BASE_URL` | No | Kan API URL (default: `https://tasks.xdeca.com/api/v1`) |
| `SPRINT_START_DATE` | No | A known sprint start date for planning window calc |
| `ADMIN_USER_IDS` | No | Comma-separated Telegram user IDs for admin access |
| `REMINDER_INTERVAL_HOURS` | No | How often to check for overdue tasks (default: `1`) |
| `DATABASE_PATH` | No | SQLite DB path (default: `./data/kan-bot.db`) |

## Local Development

```bash
cp .env.example .env  # fill in your tokens
npm install
npm run dev           # runs with tsx watch
```

Other commands:

```bash
npm run build         # TypeScript compile
npm run start         # Run compiled JS
npm run typecheck     # tsc --noEmit
npm run test          # Run tests (vitest)
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

## Deployment

Source code only — deployment config lives in [xdeca-infra](https://github.com/10xdeca/xdeca-infra) under `gremlin/`.

```bash
# From xdeca-infra repo:
./scripts/deploy-to.sh 34.116.110.7 gremlin
```

Secrets are managed via SOPS in `xdeca-infra/gremlin/secrets.yaml`.

## Project Structure

```
src/
  index.ts                        # Entry point
  agent/
    agent-loop.ts                 # Claude Sonnet agent loop (all messages route here)
    mcp-manager.ts                # MCP client (spawns kan-mcp and outline-mcp)
    tool-registry.ts              # Custom tool definitions
    system-prompt.ts              # Context-aware system prompt builder
    conversation-history.ts       # Per-chat sliding window history
  tools/
    chat-config.ts                # Workspace linking, topic config, default board
    user-mapping.ts               # Telegram ↔ Kan user mapping
    sprint-info.ts                # Sprint status and dates
    standup.ts                    # Standup configuration and responses
    bot-identity.ts               # Naming ceremony and identity
  scheduler/
    task-checker.ts               # Cron-based task reminders (no LLM)
    standup-checker.ts            # Cron-based standup prompt/summary/nudge
  services/
    anthropic-client.ts           # Shared Anthropic SDK client
    vagueness-evaluator.ts        # Claude AI vagueness detection
    bot-identity.ts               # Bot identity cache
    standup-summarizer.ts         # AI standup summary generation
  db/
    client.ts                     # SQLite connection + auto-migrations
    schema.ts                     # Drizzle ORM schema
    queries.ts                    # Database query wrappers
  utils/
    sprint.ts                     # Sprint date calculations
    mentions.ts                   # @mention parsing
    timezone.ts                   # Timezone-aware date helpers
mcp-servers/                      # Bundled MCP server source (git submodule)
```
