# Feature Tracking

Use the template in `docs/templates/feature_template.md` for new entries. Follow `agent.md` for update rules.

## Discord Digest Pipeline
Background/Goal:
- Provide daily Discord digests from subscribed RSS sources with deduplication and optional LLM summaries.

Scope (In / Out):
- In: RSS fetch/parse, dedupe, digest generation, scheduled runs, message posting.
- Out: custom per-platform scrapers and non-RSS ingestion.

Status: Done

Acceptance Criteria (DoD):
- `/fetch now` ingests sources and stores items without duplicates.
- `/digest run` posts a digest for configured channels.
- Scheduled fetch/digest run on the configured cron.
- Errors are surfaced via logs or Discord responses.

Related Files/Dirs:
- `apps/arkcore/src/rss.ts`
- `apps/arkcore/src/digest.ts`
- `apps/arkcore/src/scheduler.ts`
- `apps/arkcore/src/messaging.ts`
- `apps/arkcore/src/commands.ts`
- `prisma/schema.prisma`

Risks & Rollback:
- Risk: RSSHub or LLM provider outages degrade output quality.
- Rollback: disable digest cron or LLM settings in `.env`, run manual `/digest run` if needed.

## Editorial Writing Assistant
Background/Goal:
- Provide item-level writing suggestions and a daily editorial report for Discord posting.

Scope (In / Out):
- In: item enrichment, structured JSON output, daily report generation, Discord commands, scheduled report posting, editorial discussion threads.
- Out: writer profile personalization and manual editorial workflows.

Status: Done

Acceptance Criteria (DoD):
- New items generate `writing_suggestions` or are marked `content_insufficient` within the configured window.
- `/editorial run` generates a report and posts a summary + thread to `EDITORIAL_CHANNEL_ID`.
- Report candidates include `<url>` links and do not use Markdown link syntax.
- `content_insufficient` items are excluded from candidates and counted in the report.
- LLM or network failures do not block fetch/digest, and failures are logged or posted.
- Forwarded messages in the editorial channel create a “创作讨论” thread with LLM responses to user instructions.
- Direct URL/text messages in the editorial channel create a translation thread with Chinese output.
- Docs, prompts, and directory Change Logs are updated for the editorial feature.

Related Files/Dirs:
- `apps/arkcore/src/editorial.ts`
- `apps/arkcore/src/commands.ts`
- `apps/arkcore/src/scheduler.ts`
- `apps/arkcore/src/messaging.ts`
- `apps/arkcore/src/editorial-discussion.ts`
- `apps/arkcore/src/editorial-translation.ts`
- `prompts/editorial.item_enrichment.prompt.md`
- `prompts/editorial.daily_report.prompt.md`
- `prompts/editorial.thread_assistant.prompt.md`
- `prompts/editorial.translation.prompt.md`
- `prisma/schema.prisma`

Risks & Rollback:
- Risk: LLM latency/cost spikes or prompt drift reduce output quality.
- Rollback: clear `EDITORIAL_CHANNEL_ID` or set `EDITORIAL_ENRICH_ENABLED=false` to stop suggestions.

## Favorite Reaction Forwarder
Background/Goal:
- Forward messages to a dedicated channel when a heart reaction is added.

Scope (In / Out):
- In: heart reaction detection, message forwarding with link/context, configurable target channel.
- Out: per-user favorites, persistence, or advanced filtering.

Status: Done

Acceptance Criteria (DoD):
- Heart reactions trigger forwarding to `FAV_CHANNEL_ID`.
- Forwarded content includes origin channel, author, and message link.
- Missing configuration does not break other bot operations.

Related Files/Dirs:
- `apps/arkcore/src/favorites.ts`
- `apps/arkcore/src/discord.ts`
- `apps/arkcore/src/index.ts`
- `apps/arkcore/src/config.ts`

Risks & Rollback:
- Risk: missing intents or permissions prevent reaction events.
- Rollback: unset `FAV_CHANNEL_ID` to disable forwarding.

## Deep Dive Reaction Assistant
Background/Goal:
- Forward messages to a deeper-reading channel when an eyes reaction is added and generate an LLM deep dive.

Scope (In / Out):
- In: 👀 reaction detection, forwarding to `DEEPER_CHANNEL_ID`, deep dive generation, posting to a thread.
- Out: per-user rules, retries, or long-term analysis history UI.

Status: Done

Acceptance Criteria (DoD):
- 👀 reactions forward the source message to `DEEPER_CHANNEL_ID`.
- A deep dive summary is generated and posted in the forwarded message thread.
- Deep dive output is stored on the corresponding item record.
- Missing configuration does not affect other bot features.

Related Files/Dirs:
- `apps/arkcore/src/favorites.ts`
- `apps/arkcore/src/deeper.ts`
- `apps/arkcore/src/config.ts`
- `prisma/schema.prisma`
- `prompts/deeper.article_summary.prompt.md`

Risks & Rollback:
- Risk: LLM failures or missing content prevent deep dive output.
- Rollback: unset `DEEPER_CHANNEL_ID` or disable LLM to stop deep dive generation.

## References
- `agent.md`
- `docs/templates/feature_template.md`
