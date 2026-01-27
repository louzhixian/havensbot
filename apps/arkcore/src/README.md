# ArkCore App Source

## Purpose
Core application logic for the Discord RSS hub (ingestion, scheduling, digesting, and messaging).

## Key Files
- `index.ts`: application entry point and bootstrapping.
- `commands.ts`: Discord slash command registration and handlers.
- `scheduler.ts`: cron scheduling for fetch and digest jobs.
- `rss.ts`: RSS fetch/parse and item ingestion.
- `digest.ts`: digest generation logic.
- `editorial.ts`: editorial enrichment and daily report logic.
- `editorial-discussion.ts`: editorial channel discussion thread handler.
- `editorial-translation.ts`: editorial channel translation handler.
- `deeper.ts`: deep dive generation logic.
- `favorites.ts`: reaction-based message forwarding.
- `messaging.ts`: message formatting and output.
- `db.ts`: Prisma client setup and database helpers.
- `config.ts`: environment and runtime configuration.

## Conventions
- Keep side effects in entry points; keep modules focused on a single responsibility.
- Surface failures via logs or Discord responses, never silently.
- Update this README Change Log on any change in this directory (see `agent.md`).

## Change Log
- 2026-01-03: add directory README and conventions (files: apps/arkcore/src/README.md) impact: doc
- 2026-01-03: add editorial enrichment/report pipeline (files: apps/arkcore/src/editorial.ts, apps/arkcore/src/commands.ts, apps/arkcore/src/scheduler.ts, apps/arkcore/src/messaging.ts, apps/arkcore/src/config.ts) impact: feature
- 2026-01-03: add fetch-all command (files: apps/arkcore/src/commands.ts) impact: feature
- 2026-01-04: run editorial report after digest and add retry on incomplete output (files: apps/arkcore/src/scheduler.ts, apps/arkcore/src/editorial.ts, apps/arkcore/src/config.ts) impact: reliability
- 2026-01-04: add editorial list command and suggestion thread output (files: apps/arkcore/src/commands.ts, apps/arkcore/src/editorial.ts, apps/arkcore/src/messaging.ts) impact: feature
- 2026-01-04: add favorite reaction forwarding (files: apps/arkcore/src/favorites.ts, apps/arkcore/src/discord.ts, apps/arkcore/src/index.ts, apps/arkcore/src/config.ts) impact: feature
- 2026-01-04: adjust favorite forward formatting (files: apps/arkcore/src/favorites.ts) impact: ux
- 2026-01-04: switch favorite forwarding to native forward and delete on unreact (files: apps/arkcore/src/favorites.ts) impact: behavior
- 2026-01-04: add 👀 deep dive forwarding and analysis (files: apps/arkcore/src/deeper.ts, apps/arkcore/src/favorites.ts, apps/arkcore/src/config.ts) impact: feature
- 2026-01-05: handle GitHub raw fetch and deep dive insufficiency tracking (files: apps/arkcore/src/deeper.ts) impact: reliability
- 2026-01-05: update digest titles, overview sources list, and skip empty threads (files: apps/arkcore/src/digest.ts, apps/arkcore/src/messaging.ts) impact: ux
- 2026-01-05: add editorial discussion threads (files: apps/arkcore/src/editorial-discussion.ts, apps/arkcore/src/index.ts) impact: feature
- 2026-01-05: add deep dive fulltext override config (files: apps/arkcore/src/deeper.ts, apps/arkcore/src/config.ts) impact: config
- 2026-01-05: handle forwarded messages in editorial discussion threads (files: apps/arkcore/src/editorial-discussion.ts) impact: fix
- 2026-01-05: add editorial enrichment toggle (files: apps/arkcore/src/config.ts, apps/arkcore/src/editorial.ts, apps/arkcore/src/commands.ts, apps/arkcore/src/scheduler.ts) impact: config
- 2026-01-06: add per-channel digest logging (files: apps/arkcore/src/scheduler.ts) impact: observability
- 2026-01-06: dedupe digest items by URL per channel (files: apps/arkcore/src/digest.ts) impact: fix
- 2026-01-06: add editorial translation threads (files: apps/arkcore/src/editorial-translation.ts, apps/arkcore/src/editorial-discussion.ts, apps/arkcore/src/index.ts) impact: feature
- 2026-01-06: improve editorial translation fetch for Substack reader URLs (files: apps/arkcore/src/editorial-translation.ts) impact: fix
- 2026-01-06: support translating text file attachments in editorial channel (files: apps/arkcore/src/editorial-translation.ts) impact: feature
- 2026-01-06: remove Substack-specific translation handling (files: apps/arkcore/src/editorial-translation.ts) impact: behavior

## References
- `agent.md`
- `docs/templates/directory_readme_template.md`
