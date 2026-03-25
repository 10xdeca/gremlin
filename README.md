# Gremlin

Telegram bot for [Kan.bn](https://tasks.xdeca.com) task management — a full LLM agent with MCP tools. TypeScript + [grammY](https://grammy.dev) + Claude Sonnet + SQLite (Drizzle ORM).

**Status: Archived.** Gremlin is no longer actively running. This repo documents the architecture and features for future reference.

## How It Works

Every user message flows through a Claude Sonnet agent loop. There are no slash commands — the bot understands natural language and uses tools to fulfill requests.

```
Telegram Message → grammY → Agent Loop (Claude Sonnet + tools) → Response → Telegram
                                ├── Kan MCP (25 tools — task management)
                                ├── Outline MCP (21 tools — knowledge base)
                                ├── Radicale MCP (20 tools — calendar/contacts)
                                ├── Playwright MCP (22 tools — web browsing)
                                └── Custom tools (see below)
```

The system prompt is **context-aware**: it dynamically includes bot identity, workspace config, sprint status, team mappings, admin status, active standups, kickstart state, and topic-specific behavior rules. The agent adapts its personality based on which Telegram topic it's in (focused in PM, playful in social).

## Features

### Core Agent

| Feature | Description |
|---------|-------------|
| **Natural language task management** | Create, update, assign, move, comment on, and complete Kan cards via conversation |
| **Knowledge base search** | Search and reference the Outline wiki inline |
| **Calendar integration** | View events, create meetings, get reminders via Radicale CalDAV |
| **Web browsing** | Navigate pages, read content, take screenshots, fill forms via Playwright |
| **Research delegation** | Delegate deep research to an A2A agent (web + wiki search) |
| **Conversation memory** | Per-chat sliding window (20 messages, 30min TTL) with cross-chat context |
| **Image understanding** | Multimodal — reads images, screenshots, diagrams attached to messages |

### Automation

| Feature | Description |
|---------|-------------|
| **Task reminders** | Cron-based checks for overdue, stale, vague, unassigned tasks. AI-evaluated vagueness detection. |
| **Daily standups** | Configurable prompt/summary/nudge times per chat. AI-generated summaries. DM nudges for non-responders. |
| **Calendar reminders** | Event alerts at 24h, 1h, and 15min before start. Reads from Radicale. |
| **Token health** | Proactive OAuth token validation every 4h with admin alerts on failure. |

### People & Onboarding

| Feature | Description |
|---------|-------------|
| **New member onboarding** | Auto-DMs new group members. Learns about them conversationally. Creates Radicale contacts. |
| **Kickstart wizard** | 6-step guided setup for new groups: workspace, board/topics, team roster, projects, standups, summary. |
| **Contact scanner** | Passive image scanning in group chats — detects business cards, badges, speaker slides. Human-confirmed. |
| **Team roster** | Telegram-to-Kan user mapping, injected into system prompt for instant lookups. |

### Self-Management

| Feature | Description |
|---------|-------------|
| **Bot identity** | Naming ceremony — the team votes on the bot's name and personality. |
| **Self-diagnostics** | Read own container logs, check MCP health, view uptime and restart counts. |
| **Self-repair** | Restart individual MCP servers or the entire container. Automatic recovery from tool failures. |
| **Deploy awareness** | Reads `deploy-info.txt` to announce what changed in each deployment. |
| **GitHub integration** | Read code, browse directories, create and list issues across org repos. |
| **Direct messaging** | Send DMs to team members for private nudges or task updates. |

### Reminder Schedule

| Reminder | Frequency | When |
|----------|-----------|------|
| Overdue tasks | Daily | Always |
| Stale tasks (in-progress >14 days) | Every 2 days | Always |
| Unassigned tasks | Every 2 days | Always |
| Vague tasks (AI-evaluated) | Daily | Sprint days 1-2 |
| Missing due dates | Daily | Sprint days 1-2 |
| Members with no tasks | Daily | Sprint days 1-2 |

## Custom Tools

Beyond the ~88 MCP tools, Gremlin registers these custom tools:

| Tool | File | What it does |
|------|------|-------------|
| `get_chat_config` | `chat-config.ts` | Read workspace link + default board config |
| `link_workspace` | `chat-config.ts` | Link a Kan workspace to a chat (admin) |
| `unlink_workspace` | `chat-config.ts` | Unlink workspace (admin) |
| `set_reminder_topic` | `chat-config.ts` | Set the Telegram topic for task reminders (admin) |
| `set_social_topic` | `chat-config.ts` | Set the social/casual topic (admin) |
| `set_default_board` | `chat-config.ts` | Set default board/list for card creation (admin) |
| `get_user_mapping` | `user-mapping.ts` | Look up a Telegram↔Kan user mapping |
| `set_user_mapping` | `user-mapping.ts` | Create/update user mapping (admin) |
| `list_user_mappings` | `user-mapping.ts` | List all mappings |
| `delete_user_mapping` | `user-mapping.ts` | Remove a mapping (admin) |
| `get_sprint_info` | `sprint-info.ts` | Current sprint day, planning window status |
| `get_standup_config` | `standup.ts` | Read standup settings for a chat |
| `set_standup_config` | `standup.ts` | Configure standup times/timezone (admin) |
| `save_standup_response` | `standup.ts` | Record a user's standup update |
| `get_bot_identity` | `bot-identity.ts` | Read the bot's name/pronouns/tone |
| `start_naming_ceremony` | `bot-identity.ts` | Begin a name/personality vote |
| `get_deploy_info` | `deploy-info.ts` | Read what changed in the current deployment |
| `get_server_logs` | `server-ops.ts` | Read Docker container logs |
| `get_container_info` | `server-ops.ts` | Container uptime, restart count |
| `check_mcp_health` | `server-ops.ts` | Health status of each MCP server |
| `restart_mcp_server` | `server-ops.ts` | Restart a specific MCP server |
| `restart_bot` | `server-ops.ts` | Restart the entire container (nuclear) |
| `send_dm` | `direct-message.ts` | Send a DM to a team member |
| `read_github_file` | `github-repo.ts` | Read a file from a GitHub repo |
| `list_github_directory` | `github-repo.ts` | Browse a directory in a repo |
| `create_github_issue` | `github-repo.ts` | File a GitHub issue |
| `list_github_issues` | `github-repo.ts` | List open issues |
| `research` | `research.ts` | Delegate research to an A2A agent |
| `start_kickstart` | `kickstart.ts` | Begin 6-step guided setup (admin) |
| `get_kickstart_state` | `kickstart.ts` | Read kickstart progress |
| `advance_kickstart` | `kickstart.ts` | Move to next kickstart step |
| `complete_kickstart` | `kickstart.ts` | Finish kickstart flow |
| `cancel_kickstart` | `kickstart.ts` | Abandon kickstart |

## Architecture

```
src/
  index.ts                        # Entry point, Grammy handlers, startup
  agent/
    agent-loop.ts                 # Claude Sonnet agent loop (all messages route here)
    mcp-manager.ts                # MCP client (spawns 4 MCP servers as subprocesses)
    tool-registry.ts              # Custom + MCP tool registry, execution routing
    system-prompt.ts              # Context-aware system prompt builder
    conversation-history.ts       # Per-chat sliding window + cross-chat context
  a2a/
    research-negotiator.ts        # A2A protocol client for research agent
  tools/
    chat-config.ts                # Workspace linking, topic config, default board
    user-mapping.ts               # Telegram ↔ Kan user mapping
    sprint-info.ts                # Sprint status and dates
    standup.ts                    # Standup configuration and responses
    bot-identity.ts               # Naming ceremony and identity
    deploy-info.ts                # Deployment change information
    server-ops.ts                 # Container logs, MCP health, restart
    direct-message.ts             # DM team members
    github-repo.ts                # Code reading, issue management
    research.ts                   # A2A research delegation
    kickstart.ts                  # Guided group setup wizard
  scanner/
    contact-scanner.ts            # Passive image-to-contact pipeline
  scheduler/
    task-checker.ts               # Cron: overdue/stale/vague task reminders
    standup-checker.ts            # Cron: standup prompt/summary/nudge
    calendar-checker.ts           # Cron: calendar event reminders
    token-health.ts               # Cron: OAuth token validation
  services/
    anthropic-client.ts           # Shared Anthropic SDK client + OAuth
    vagueness-evaluator.ts        # AI vagueness detection for cards
    bot-identity.ts               # Bot identity cache
    standup-summarizer.ts         # AI standup summary generation
    admin-alerts.ts               # Admin notification service
  db/
    client.ts                     # SQLite connection + auto-migrations
    schema.ts                     # Drizzle ORM schema (12 tables)
    queries.ts                    # Database query wrappers
  utils/
    sprint.ts                     # Sprint date calculations
    mentions.ts                   # @mention parsing
    timezone.ts                   # Timezone-aware date helpers
    docker.ts                     # Docker API for self-diagnostics
    telegram.ts                   # Telegram API helpers
scripts/
    get-refresh-token.sh          # OAuth token helper
    exchange-keychain-token.sh    # Keychain token exchange
mcp-servers/                      # Bundled MCP servers (git submodule)
  packages/kan/                   # Kan task management (25 tools)
  packages/outline/               # Outline wiki (21 tools)
  packages/radicale/              # Radicale CalDAV/CardDAV (20 tools)
```

### Database Schema (12 tables)

| Table | Purpose |
|-------|---------|
| `telegram_workspace_links` | Links chats to Kan workspaces |
| `telegram_user_links` | Maps Telegram users to Kan accounts |
| `telegram_reminders` | Tracks sent reminders to prevent spam |
| `bot_identity` | Bot name, pronouns, tone |
| `default_board_config` | Default board/list per chat |
| `oauth_tokens` | Persisted OAuth refresh tokens |
| `standup_config` | Per-chat standup settings |
| `standup_sessions` | Daily standup state |
| `standup_responses` | Individual standup updates |
| `calendar_reminders` | Tracks sent calendar reminders |
| `naming_ceremonies` | Active/completed naming votes |
| `kickstart_sessions` | Guided setup wizard state |
| `conversations` | Chat activity tracking (TTL) |
| `conversation_messages` | Message history for context |

## Testing

Three layers run in CI (`typecheck → test → build`):

- **Unit tests** — Sprint utils, timezone, mentions, DB queries, conversation history, kickstart, standup, contact scanner
- **Integration tests** — Full agent loop with mocked Claude API and MCP tools
- **Smoke tests** — Module imports, schema application, system prompt building, tool registration, env var documentation

```bash
npm test             # 138 tests across 11 test files
npm run test:watch   # Watch mode
npm run test:coverage # With coverage
```

## CI/CD

| Workflow | Trigger | What it does |
|----------|---------|-------------|
| `ci.yml` | Push/PR to main | Typecheck → test → build |
| `deploy.yml` | Push to main (after CI) | Rsync to server, docker compose up, health check |
| `release.yml` | Conventional commits | release-please: version bump, changelog, git tag |

## Health Check

HTTP server on port 8080:
- `GET /health` — Component status (bot, MCP servers, auth). 200/503.
- `GET /version` — App version + deployed git SHA.

## Environment Variables

See [`.env.example`](.env.example) for the full list. Key groups:

| Group | Variables |
|-------|-----------|
| **Telegram** | `TELEGRAM_BOT_TOKEN`, `ADMIN_USER_IDS` |
| **Kan** | `KAN_BASE_URL`, `KAN_API_KEY` |
| **Outline** | `OUTLINE_BASE_URL`, `OUTLINE_API_KEY` |
| **Claude** | `CLAUDE_REFRESH_TOKEN` (or `ANTHROPIC_API_KEY` fallback) |
| **Radicale** | `RADICALE_URL`, `RADICALE_USERNAME`, `RADICALE_PASSWORD`, `RADICALE_ADDRESS_BOOK_URL` |
| **GitHub** | `GITHUB_TOKEN`, `GITHUB_REPO` |
| **Optional** | `PLAYWRIGHT_ENABLED`, `CONTACT_SCANNER_ENABLED`, `RESEARCH_AGENT_URL` |
| **Infra** | `DATABASE_PATH`, `HEALTH_PORT`, `DEPLOY_SHA`, `WEBHOOK_URL` |

## Deployment

Source code only. Deployment config lives in [xdeca-infra](https://github.com/10xdeca/xdeca-infra) under `gremlin/`.

```bash
# From xdeca-infra repo:
./scripts/deploy-to.sh <server-ip> gremlin
```

- Docker container built from this Dockerfile
- Secrets managed via SOPS (`xdeca-infra/gremlin/secrets.yaml`)
- Webhook mode via Caddy reverse proxy (`gremlin.xdeca.com`)
- SQLite DB persisted via Docker volume (`gremlin_data`)

## What We Built and What We Learned

Gremlin started as a simple task reminder bot and evolved into a full LLM agent with 120+ tools, 4 MCP servers, and a rich set of autonomous behaviors. Key things that worked well:

**LLM-as-controller pattern.** Routing all messages through a single agent loop with tools was far more flexible than building a command parser. The bot handles ambiguous requests, multi-step workflows, and context-dependent behavior without any branching logic in code.

**System prompt as configuration.** Instead of roles or modes, the system prompt dynamically assembles context sections based on chat type, topic, and state. The same agent becomes a focused PM assistant or a casual social bot just by changing what context it sees.

**MCP for external services.** Wrapping Kan, Outline, and Radicale as MCP servers meant the agent could discover and use tools without custom integration code for each service. Adding a new service is just spawning another subprocess.

**State-in-DB, behavior-in-prompt.** Features like kickstart and standups store minimal state in SQLite (which step, which session) and let the system prompt tell the agent what to do with that state. The LLM handles the conversational complexity.

**Self-repair.** The bot can read its own logs, health-check its MCP servers, restart failed components, and announce its own deployments. This reduced operational burden significantly.

### What We'd Do Differently

- **Persistent memory** beyond the 30-min TTL. The conversation sliding window works for short interactions but loses context across sessions. An Outline-backed memory store was planned but never shipped.
- **Structured tool outputs.** MCP tools return JSON strings that the agent parses. A typed response layer would have caught integration issues earlier.
- **Rate limiting.** No per-user rate limits — a chatty user could rack up API costs. Should have been there from day one.

## License

Private repository. All rights reserved.
