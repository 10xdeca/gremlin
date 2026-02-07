# xdeca-pm-bot

Telegram bot for [Kan.bn](https://tasks.xdeca.com) task management. Sends reminders about overdue, stale, vague, and unassigned tasks. Uses Claude AI for vagueness evaluation.

## Commands

| Command | Description |
|---------|-------------|
| `/start <workspace>` | Link chat to a Kan workspace |
| `/settopic` | Set reminders to post in this forum topic |
| `/map @user email` | Map a Telegram user to their Kan email (DM only) |
| `/unlink` | Unlink chat from workspace |
| `/link` | Check your account mapping status |
| `/unlinkme` | Remove your account mapping |
| `/mytasks` | View your assigned tasks |
| `/overdue` | View all overdue tasks |
| `/done <task-id>` | Mark a task as complete |
| `/comment <task-id> <text>` | Add a comment to a task |

## Automatic Reminders

| Reminder | Frequency | When |
|----------|-----------|------|
| Overdue tasks | Daily | Always |
| Stale tasks (in progress >14 days) | Every 2 days | Always |
| Unassigned tasks | Every 2 days | Always |
| Vague tasks (AI-evaluated) | Daily | Sprint days 1-2 |
| Missing due dates | Daily | Sprint days 1-2 |
| Members with no tasks | Daily | Sprint days 1-2 |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token |
| `KAN_SERVICE_API_KEY` | Yes | API key for Kan.bn |
| `ANTHROPIC_API_KEY` | Yes | Claude API key (vagueness evaluation) |
| `KAN_BASE_URL` | No | Kan.bn URL (default: `https://tasks.xdeca.com`) |
| `SPRINT_START_DATE` | No | Sprint start date for planning window calc |
| `REMINDER_INTERVAL_HOURS` | No | Check frequency in hours (default: `1`) |
| `DATABASE_PATH` | No | SQLite DB path (default: `./data/kan-bot.db`) |

## Local Development

```bash
cp .env.example .env  # fill in your tokens
npm install
npm run dev            # runs with tsx watch
```

## Deployment

This repo contains only the source code. Deployment config lives in [xdeca-infra](https://github.com/10xdeca/xdeca-infra) under `kan-bot/`.

The deploy script (`xdeca-infra/scripts/deploy-to.sh`) rsyncs this source into `kan-bot/src/` on the server, then builds the Docker image and starts the container:

```bash
# From xdeca-infra repo:
./scripts/deploy-to.sh 13.54.159.183 kan-bot
```

Secrets are managed via SOPS in `xdeca-infra/kan-bot/secrets.yaml`.

## Project Structure

```
src/
  index.ts                  # Entry point, command registration
  api/kan-client.ts         # Kan.bn API client
  bot/commands/             # Telegram command handlers
  bot/middleware/auth.ts    # Auth middleware
  db/client.ts              # SQLite connection + migrations
  db/schema.ts              # Drizzle ORM schema
  db/queries.ts             # Database queries
  scheduler/task-checker.ts # Cron-based reminder system
  services/vagueness-evaluator.ts  # Claude AI vagueness check
  utils/format.ts           # Message formatting (MarkdownV2)
  utils/sprint.ts           # Sprint date calculations
```
