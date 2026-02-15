# xdeca-pm-bot

Telegram bot for Kan.bn task management. TypeScript + Grammy + SQLite (Drizzle ORM).

## Build & Run

```bash
npm run dev          # Development with tsx watch
npm run build        # TypeScript compile
npm run start        # Run compiled JS
npm run typecheck    # tsc --noEmit
```

## Architecture

- **Grammy** for Telegram bot framework
- **better-sqlite3** + **Drizzle ORM** for local SQLite storage
- **node-cron** for scheduled task checks
- **@anthropic-ai/sdk** for Claude-powered vagueness evaluation
- DB migrations run automatically on startup in `src/db/client.ts`

## Deployment

This is the source code only. Deployment config is in `xdeca-infra/xdeca-pm-bot/`:
- `docker-compose.yml` builds from this source (rsynced from `xdeca-pm-bot/` to `xdeca-pm-bot/src/` on server)
- Secrets in `secrets.yaml` (SOPS-encrypted)
- Deploy: `./scripts/deploy-to.sh 34.116.110.7 xdeca-pm-bot` from xdeca-infra repo
- Server: GCP Compute Engine (e2-medium) at 34.116.110.7
- Logs: `ssh ubuntu@34.116.110.7 'docker logs -f xdeca-pm-bot'`

## Key Patterns

- All command handlers are async functions taking Grammy `Context`
- DB queries are async wrappers around synchronous Drizzle calls
- Reminders use a `(card_public_id, telegram_chat_id, reminder_type)` UNIQUE constraint to prevent duplicates
- `sendReminderMessage()` handles topic routing via `message_thread_id`
- Sprint planning window (days 1-2) gates certain reminder types
