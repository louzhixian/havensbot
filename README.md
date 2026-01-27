# ArkCore MVP

ArkCore is a Discord RSS hub that fetches feeds, deduplicates items, and posts daily digests.

## Docs
- `agent.md` (agent workflow and documentation rules)
- `docs/README.md` (documentation map and templates)
- `DECISIONS.md` (key architectural decisions)
- `RUNBOOK.md` (ops and troubleshooting)
- `docs/features.md` (feature tracking)
- `prompts/README.md` (prompt management)
- `docs/setup_log.md` (setup history)

## Requirements
- Docker Engine + Docker Compose plugin
- Discord bot token with application commands enabled

## Quick Start
1. Copy `.env.example` to `.env` and fill in values.
2. Start services:

```bash
sg docker -c "docker compose up -d --build"
```

3. Run verification:

```bash
sg docker -c "bash scripts/verify.sh"
```

## Commands
- `/ping`
- `/source add rss url:<feed[,feed2,...]> name:<optional>`
- `/source add others url:<page_url[,page2,...]> name:<optional>`
- `/source list`
- `/source remove url:<feed[,feed2,...]>`
- `/fetch now`
- `/fetch all`
- `/digest run`
- `/editorial run`
- `/editorial preview`
- `/editorial status`
- `/editorial list`

Notes:
- For batch operations, separate URLs with spaces or commas. When adding multiple URLs, the `name` option is ignored.

## Notes
- Edit `.env` to control `FETCH_INTERVAL_MINUTES`, `DIGEST_CRON`, `TZ`, and `LLM_MAX_TOKENS`.
- Set `LLM_PROVIDER=openai_compat` and provide `LLM_API_KEY` + `LLM_MODEL` for LLM summaries.
- Digest thread mode posts a single overview message in the channel and item-by-item messages in a thread (toggle with `DIGEST_THREAD_MODE`).
- `/source add` can only be used in guild text or announcement channels (not threads/forums).
- Set `EDITORIAL_CHANNEL_ID` to enable editorial reports; reports run on `DIGEST_CRON` and post a summary + thread.
- Set `EDITORIAL_ENRICH_ENABLED=false` to pause item-level editorial suggestions.
- Set `FAV_CHANNEL_ID` to forward messages when a user reacts with a heart emoji.
- Set `DEEPER_CHANNEL_ID` to forward messages when a user reacts with 👀 and post a deep dive thread.
- Forward a message into the editorial channel to start a “创作讨论” thread with LLM assistance.
- Post a URL or text directly in the editorial channel to start a translation thread.
- `/editorial list` posts writing suggestions in a thread for review in the current channel.
- Editorial output uses `EDITORIAL_WINDOW_HOURS`, `EDITORIAL_TWEET_COUNT`, `EDITORIAL_BLOG_COUNT`, `EDITORIAL_MAX_ITEMS`, and `ENRICH_MIN_CONTENT_CHARS` to control cost and scope.
- Deep dive uses `DEEPER_FULLTEXT_MAX_CHARS` (set to 0 for no truncation) and falls back to `FULLTEXT_MAX_CHARS`.

## Source Add Paths
1. `/source add rss`: add official RSS/Atom feeds directly (recommended).
2. `/source add others`: provide a normal website URL; ArkCore checks for official feeds first, otherwise tries RSSHub resolve.
   - GitHub repository URLs are handled with official Atom feeds (commits by default).

To diagnose RSSHub issues, check container logs: `docker compose logs --tail=200 rsshub`.
