# Setup Log

This file archives setup and environment history. Update when infra/setup steps change (see RUNBOOK.md and agent.md).

# SETUP_LOG

## Step 0 (Start) - 2025-12-22 22:06:57 JST
Purpose: Initialize audit files and record current environment info
Commands:
- `uname -a`
- `whoami`
- `pwd`
- `node -v`
- `docker --version`
- `docker compose version`

Result:
- uname: `Linux ark-core 6.8.0-71-generic #71-Ubuntu SMP PREEMPT_DYNAMIC Tue Jul 22 16:52:38 UTC 2025 x86_64 x86_64 x86_64 GNU/Linux `
- whoami: `zhixian `
- pwd: `/home/zhixian/arkcore `
- node: `v24.12.0 `
- docker: `/bin/bash: line 23: docker: command not found `
- docker compose: `/bin/bash: line 24: docker: command not found `

Rollback:
- Remove this Step 0 entry; if newly created, delete `SETUP_LOG.md`, `DECISIONS.md`, `RUNBOOK.md`

## Step 1 (Docker/Compose Check) - 2025-12-22 22:09:04 JST
Purpose: Verify docker and docker compose availability
Commands:
- `docker --version`
- `docker compose version`

Result:
- docker: `/bin/bash: line 6: docker: command not found `
- docker compose: `/bin/bash: line 7: docker: command not found `
- status: failure

Rollback:
- No changes beyond this log entry

## AUTH REQUIRED - Docker Install (pending approval)
Time: 2025-12-22 22:09:30 JST
Purpose: Install Docker Engine and Docker Compose plugin on Ubuntu
Commands (no secrets):
- `sudo apt-get update`
- `sudo apt-get install -y docker.io docker-compose-plugin`
- `sudo systemctl enable --now docker`
- `sudo usermod -aG docker $USER`

Notes:
- After `usermod`, a new login session is required for group changes to take effect.

Rollback:
- `sudo systemctl disable --now docker`
- `sudo apt-get remove -y docker.io docker-compose-plugin`
- `sudo apt-get autoremove -y`

## Step 1a (Docker Install Attempt 1) - 2025-12-22 22:11:40 JST
Purpose: Install Docker Engine and Docker Compose plugin (approved)
Commands:
- `sudo apt-get update`
- `sudo apt-get install -y docker.io docker-compose-plugin`
- `sudo systemctl enable --now docker`
- `sudo usermod -aG docker zhixian`

Result:
- status: failure (command timed out in harness; no apt processes running afterward)

Rollback:
- `sudo systemctl disable --now docker`
- `sudo apt-get remove -y docker.io docker-compose-plugin`
- `sudo apt-get autoremove -y`

## Step 1b (Docker Install Attempt 2) - 2025-12-22 22:14:02 JST
Purpose: Install Docker Engine and Docker Compose plugin (approved)
Commands:
- `sudo apt-get update`
- `sudo apt-get install -y docker.io docker-compose-plugin`
- `sudo systemctl enable --now docker`
- `sudo usermod -aG docker zhixian`

Result:
- status: failure (command timed out in harness after 120s)

Rollback:
- `sudo systemctl disable --now docker`
- `sudo apt-get remove -y docker.io docker-compose-plugin`
- `sudo apt-get autoremove -y`

## Step 1c (Manual Install Attempt by User) - 2025-12-22 22:12:10 JST
Purpose: User attempted Docker installation manually
Commands (user-reported):
- `sudo apt-get update`
- `sudo apt-get install -y docker.io docker-compose-plugin`
- `sudo systemctl enable --now docker`
- `sudo usermod -aG docker $USER`

Result (user-reported):
- `docker-compose-plugin` package not found
- `docker.service` unit not found
- `docker` group not found

Rollback:
- Not applicable (no packages installed)

## Step 1d (Manual Docker Repo Attempt by User) - 2025-12-22 22:14:30 JST
Purpose: User attempted Docker official repo setup and install
Commands (user-reported):
- `sudo apt-get update`
- `sudo apt-get install -y ca-certificates curl gnupg`
- `sudo install -m 0755 -d /etc/apt/keyrings`
- `curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/`
- `sudo chmod a+r /etc/apt/keyrings/docker.gpg`
- `echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null`
- `sudo apt-get update`
- `sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`
- `sudo systemctl enable --now docker`
- `sudo usermod -aG docker $USER`

Result (user-reported):
- gpg dearmor failed because output path was a directory
- docker.gpg not created; repo list not written
- docker-ce packages not found; docker service/group missing

Rollback:
- Remove `/etc/apt/sources.list.d/docker.list` if created; remove `/etc/apt/keyrings/docker.gpg` if created

## Step 1e (Docker/Compose Re-Check) - 2025-12-22 22:28:27 JST
Purpose: Verify docker and docker compose availability after install
Commands:
- `docker --version`
- `docker compose version`

Result:
- docker: `Docker version 29.1.3, build f52814d `
- docker compose: `Docker Compose version v5.0.0 `
- status: success

Rollback:
- `sudo systemctl disable --now docker`
- `sudo apt-get remove -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`
- `sudo apt-get autoremove -y`

## Step 2 (Project Skeleton) - 2025-12-22 22:37:23 JST
Purpose: Create ArkCore project skeleton, configs, and initial Prisma migration
Commands:
- `mkdir -p apps/arkcore/src prisma/migrations scripts`
- `cat > .env` (placeholders only, no secrets)
- `chmod 600 .env`
- `cat > .env.example`
- `cat > .gitignore`
- `cat > package.json`
- `cat > tsconfig.json`
- `cat > prisma/schema.prisma`
- `cat > apps/arkcore/src/index.ts`
- `cat > scripts/verify.sh`
- `cat > docker-compose.yml`
- `cat > README.md`
- `npm install` (first attempt timed out; retried)
- `npm install -D`
- `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`

Result:
- Project structure and config files created
- Dependencies installed
- Initial Prisma migration created under `prisma/migrations`

Rollback:
- Remove created files/directories if needed
- Remove `node_modules` and `package-lock.json`

## Step 2 Verification - 2025-12-22 22:37:37 JST
Purpose: Verify project skeleton setup
Command:
- `scripts/verify.sh`

Result:
- success (placeholder checks passed)

Rollback:
- No changes beyond this log entry

## Step 2 (Add DATABASE_URL Placeholder) - 2025-12-22 22:37:56 JST
Purpose: Add DATABASE_URL placeholder to .env and .env.example
Commands:
- edit `.env`
- edit `.env.example`

Result:
- DATABASE_URL placeholder added (no secrets)

Rollback:
- Remove DATABASE_URL lines if needed

## Step 3 (Core Logic Implementation) - 2025-12-22 22:49:29 JST
Purpose: Implement Discord commands, RSS ingest, digest generation, and scheduling
Commands:
- `cat > apps/arkcore/src/config.ts`
- `cat > apps/arkcore/src/utils.ts`
- `cat > apps/arkcore/src/db.ts`
- `cat > apps/arkcore/src/rss.ts`
- `cat > apps/arkcore/src/digest.ts`
- `cat > apps/arkcore/src/commands.ts`

- `cat > apps/arkcore/src/discord.ts`
- `cat > apps/arkcore/src/messaging.ts`
- `cat > apps/arkcore/src/scheduler.ts`
- `cat > apps/arkcore/src/index.ts`
- `npm install -D @types/node-cron`
- `npm run build`

Result:
- Core application modules created
- TypeScript build succeeded

Rollback:
- Revert the new source files and dependency changes

## Step 3 Verification - 2025-12-22 22:49:35 JST
Purpose: Verify core logic implementation (current checks)
Command:
- `scripts/verify.sh`

Result:
- success (placeholder checks passed)

Rollback:
- No changes beyond this log entry

## Step 4 (Dockerize and Start) - 2025-12-22 23:14:25 JST
Purpose: Dockerize app, start services, and run verification
Commands:
- `cat > Dockerfile`
- `cat > scripts/docker-entrypoint.sh`
- `cat > .dockerignore`
- edit `docker-compose.yml`
- edit `scripts/verify.sh`
- `cat > apps/arkcore/src/verify.ts`
- `sg docker -c "docker compose up -d --build"`
- `sg docker -c "bash scripts/verify.sh"`

Result:
- Docker image built; containers started
- App container repeatedly restarting due to Prisma auth error (P1000); verification failed
- Likely cause: .env still contains placeholder DB credentials or DATABASE_URL not updated

Rollback:
- `sg docker -c "docker compose down"`
- Remove Dockerfile/scripts/docker-entrypoint.sh/.dockerignore if reverting

## Step 4 (Retry - Reset Volume and Start) - 2025-12-24 16:56:42 JST
Purpose: Reset Postgres volume and restart services to apply correct credentials
Commands:
- `sg docker -c "docker compose down -v"`
- `sg docker -c "docker compose up -d --build"`
- `sg docker -c "bash scripts/verify.sh"`

Result:
- Containers rebuilt and started
- Verification succeeded: db ok, discord ok, digest ok

Rollback:
- `sg docker -c "docker compose down -v"`

## Step 5 (RSSHub + /source add x) - 2025-12-24 17:32:34 JST
Purpose: Add RSSHub service and X handle command support
Commands:
- edit `docker-compose.yml`
- edit `.env.example`
- edit `apps/arkcore/src/config.ts`
- edit `apps/arkcore/src/commands.ts`
- `sg docker -c "docker compose up -d --build"` (first attempt failed)
- edit `apps/arkcore/src/commands.ts` (fix regex typo)
- `sg docker -c "docker compose up -d --build"`
- `sg docker -c "bash scripts/verify.sh"`

Result:
- RSSHub service added (no public ports)
- /source add x implemented using RSSHUB_BASE_URL
- Build succeeded after fixing regex typo; verification passed

Rollback:
- `sg docker -c "docker compose down"`
- Remove RSSHub service and command changes if needed

## Step 5a (Fix verify.sh rg dependency) - 2025-12-24 17:39:39 JST
Purpose: Make verification script work without ripgrep
Commands:
- edit `scripts/verify.sh`
- `sg docker -c "bash scripts/verify.sh"`

Result:
- verify script now works without rg
- Verification succeeded

Rollback:
- Revert changes to `scripts/verify.sh` if needed

## Step 5b (/fetch now + RSSHub X handle) - 2025-12-24 18:19:55 JST
Purpose: Add /fetch now command and finalize RSSHub X handle support
Commands:
- edit `apps/arkcore/src/rss.ts`
- edit `apps/arkcore/src/commands.ts`
- edit `README.md`
- `sg docker -c "docker compose up -d --build"`
- `sg docker -c "bash scripts/verify.sh"`

Result:
- /fetch now command added (channel-scoped fetch)
- Build and verification succeeded

Rollback:
- `sg docker -c "docker compose down"`

## Step 6 (Digest Summary + Dedup Display Fixes) - 2025-12-24 19:00:26 JST
Purpose: Improve LLM summaries, remove duplicate digest rendering, add full-text extraction
Commands:
- edit `apps/arkcore/src/digest.ts`
- edit `apps/arkcore/src/rss.ts`
- edit `apps/arkcore/src/messaging.ts`
- edit `apps/arkcore/src/commands.ts`
- edit `apps/arkcore/src/config.ts`
- edit `apps/arkcore/src/utils.ts`
- edit `apps/arkcore/src/verify.ts`
- `npm install @mozilla/readability jsdom p-limit`
- `npm install -D @types/jsdom`
- `npm run build`
- `sg docker -c "docker compose up -d --build"`
- `sg docker -c "bash scripts/verify.sh"`

Result:
- LLM summaries now use snippets + optional full-text
- Digest rendering uses embed-only summary (no duplicate plain text)
- Verify script passes; LLM smoke test skips when provider=none

Rollback:
- Revert modified source files and package changes
- `sg docker -c "docker compose down"`

## Step 6a (Digest Summary Finalize) - 2025-12-24 19:05:02 JST
Purpose: Finalize summary limits and rebuild containers
Commands:
- edit `apps/arkcore/src/digest.ts`
- `npm run build` (timed out in harness)
- `sg docker -c "docker compose up -d --build"`
- `sg docker -c "bash scripts/verify.sh"`

Result:
- Docker build succeeded and services restarted
- Verification succeeded; LLM smoke test skipped (provider=none)

Rollback:
- `sg docker -c "docker compose down"`

## Step 6b (Strip HTML + Bullet Render) - 2025-12-24 19:33:33 JST
Purpose: Clean HTML from summaries and stabilize embed bullet formatting
Commands:
- edit `apps/arkcore/src/utils.ts`
- edit `apps/arkcore/src/rss.ts`
- edit `apps/arkcore/src/digest.ts`
- `sg docker -c "docker compose build app"`
- `sg docker -c "docker compose up -d"`
- `sg docker -c "bash scripts/verify.sh"`

Result:
- HTML stripped from snippets
- Summary bullets rendered with visible markers
- Rebuild succeeded; verification passed

Rollback:
- Revert changes to source files
- `sg docker -c "docker compose down"`

## Step 7 (LLM Prompt + Build Cache) - 2025-12-24 21:30:09 JST
Purpose: Update LLM item summary prompt and add BuildKit cache for faster Docker builds
Commands:
- edit `apps/arkcore/src/digest.ts`
- edit `tsconfig.json`
- edit `.gitignore`
- edit `Dockerfile`

Result:
- LLM summary prompt updated to one-sentence "why it matters" phrasing
- TypeScript incremental build info moved to `.tsbuildinfo/` for caching
- Docker build uses BuildKit cache mounts for npm and tsbuildinfo

Rollback:
- Revert changes in `apps/arkcore/src/digest.ts`, `tsconfig.json`, `.gitignore`, `Dockerfile`

## Step 7a (Build Attempt with BuildKit) - 2025-12-24 21:30:52 JST
Purpose: Rebuild containers with BuildKit caching enabled
Commands:
- `sg docker -c "DOCKER_BUILDKIT=1 docker compose up -d --build"`

Result:
- status: failure (`Cannot open audit interface - aborting.`)

Rollback:
- No changes applied (build aborted)

## Step 7b (Build Completed with BuildKit) - 2025-12-24 21:54:10 JST
Purpose: Rebuild containers after enabling BuildKit cache mounts
Commands (user-reported):
- `sg docker -c "docker compose up -d --build"`

Result (user-reported):
- build completed in ~1170s
- containers up: postgres healthy, rsshub running, app recreated

Rollback:
- `sg docker -c "docker compose down"`

## Step 7c (Resource Check) - 2025-12-24 21:56:11 JST
Purpose: Verify system resource headroom after slow build
Commands (user-reported):
- `docker stats --no-stream`
- `free -h`

Result (user-reported):
- total memory: ~961MiB, available: ~208MiB, free: ~74MiB
- swap: 0B configured
- app container memory: ~114MiB; rsshub: ~201MiB; postgres: ~40MiB

Rollback:
- No changes applied (read-only checks)

## Step 7d (Swap Added by User) - 2025-12-24 22:02:12 JST
Purpose: Add 2G swap to improve TypeScript build performance
Commands (user-reported):
- `sudo fallocate -l 2G /swapfile`
- `sudo chmod 600 /swapfile`
- `sudo mkswap /swapfile`
- `sudo swapon /swapfile`
- `sudo sh -c 'echo "/swapfile none swap sw 0 0" >> /etc/fstab'`

Result (user-reported):
- swap enabled (2G)

Rollback:
- `sudo swapoff /swapfile`
- `sudo rm -f /swapfile`
- remove the `/swapfile` line from `/etc/fstab`

## Step 12 (Digest Overview Cleanup) - 2025-12-28 00:08:01 JST
Purpose: Remove digest trends and render digest window using configured timezone
Commands:
- edit `apps/arkcore/src/utils.ts`
- edit `apps/arkcore/src/messaging.ts`
- edit `apps/arkcore/src/commands.ts`
- edit `apps/arkcore/src/scheduler.ts`
- edit `apps/arkcore/src/digest.ts`
- edit `DECISIONS.md`

Result:
- Digest overview no longer displays trends
- Digest window uses readable date/time in `TZ`
- `sendDigestOverview` now requires config for timezone

Rollback:
- Revert the above files to the previous versions

## Step 13 (Digest Guardrails) - 2025-12-31 19:04:51 JST
Purpose: Isolate digest failures per channel and block source add in non-text channels
Commands:
- edit `apps/arkcore/src/scheduler.ts`
- edit `apps/arkcore/src/commands.ts`
- edit `README.md`
- edit `DECISIONS.md`

Result:
- Digest job logs per-channel failures without stopping other channels
- `/source add` blocked in threads/forums and non-text channels

Rollback:
- Revert the above files to the previous versions

## Step 14 (Digest Cron Debug Logs) - 2026-01-03 09:16:55 JST
Purpose: Add scheduler logs to verify digest cron ticks
Commands:
- edit `apps/arkcore/src/scheduler.ts`

Result:
- Scheduler logs include cron config and digest tick timestamps

Rollback:
- Revert the above file to the previous version

## Step 15 (Cron Catch-Up + Cleanup) - 2026-01-03 09:26:29 JST
Purpose: Enable cron missed execution recovery and remove invalid channel sources
Commands:
- edit `apps/arkcore/src/scheduler.ts`
- database cleanup (remove channel 1453356376146317312 sources/items/digests)

Result:
- Cron schedules recover missed executions after restarts
- Channel 1453356376146317312 removed from digest scheduling

Rollback:
- Revert `apps/arkcore/src/scheduler.ts`
- Restore the deleted records from backup if needed

## Step 13 (Batch Source Add/Remove) - 2025-12-27 22:08:25 JST
Purpose: Support batch add/remove for /source commands using space/comma-separated URLs.
Commands:
- edit `apps/arkcore/src/commands.ts`
- edit `README.md`

Result:
- /source add rss, /source add others, and /source remove accept multiple URLs.
- Batch replies summarize added/existing/invalid/failures; name ignored in batch mode.

Rollback:
- Revert changes in `apps/arkcore/src/commands.ts` and `README.md`.

## Step 14 (Refactor Command Helpers) - 2025-12-27 22:17:23 JST
Purpose: Split command helper logic into focused modules to reduce commands.ts complexity.
Commands:
- add `apps/arkcore/src/source-utils.ts`
- add `apps/arkcore/src/reply-utils.ts`
- add `apps/arkcore/src/source-handlers.ts`
- edit `apps/arkcore/src/commands.ts`

Result:
- Source-related parsing, RSSHub resolve, and batch reply formatting moved to utility modules.
- /source handlers now live in `source-handlers.ts`; commands.ts routes to handlers.

Rollback:
- Remove the new helper files and restore `apps/arkcore/src/commands.ts`.

## Step 15 (Initial Backfill Cap + Fulltext Limit Config) - 2025-12-27 22:33:38 JST
Purpose: Cap initial ingest for new sources and make full-text fetch size configurable.
Commands:
- edit `apps/arkcore/src/config.ts`
- edit `apps/arkcore/src/rss.ts`
- edit `apps/arkcore/src/digest.ts`
- edit `apps/arkcore/src/commands.ts`
- edit `apps/arkcore/src/scheduler.ts`
- edit `apps/arkcore/src/index.ts`
- edit `.env.example`
- edit `DECISIONS.md`

Result:
- New `NEW_SOURCE_MAX_ITEMS` (.env) limits first-time ingest to recent items (default 3).
- New `FULLTEXT_MAX_CHARS` (.env) controls LLM full-text fetch size (default 2000).
- RSS ingest functions now accept config for initial backfill cap.

Rollback:
- Revert the files listed above.

## Step 16 (Post-change Checklist + Commit) - 2025-12-27 22:36:31 JST
Purpose: Document the standard post-change checklist and commit the update.
Commands:
- edit `RUNBOOK.md`
- `git add -A`
- `git commit -m "..."` (message varies)

Result:
- Post-change checklist recorded in `RUNBOOK.md` (update docs, rebuild, verify, commit).
- Committed changes: `feat: cap new-source backfill and refactor source commands`.

Rollback:
- Revert `RUNBOOK.md` and reset the commit if needed.

## Step 17 (Channel Item Reset) - 2025-12-27 22:43:39 JST
Purpose: Clear items and reset fetch state for a specific channel.
Commands:
- `docker compose exec -T postgres psql -U arkcore arkcore -c "<delete items + reset sources>"`

Result:
- Deleted 815 items for channel `1453301052865773650`.
- Reset `etag`, `lastModified`, and `lastFetchedAt` for 6 sources in that channel.

Rollback:
- None (data deletion).

## Step 18 (Channel Item Reset) - 2025-12-27 23:02:33 JST
Purpose: Clear items and reset fetch state for a specific channel after source changes.
Commands:
- `docker compose exec -T postgres psql -U arkcore arkcore -c "<delete items + reset sources>"`

Result:
- Deleted 941 items for channel `1453301052865773650`.
- Reset `etag`, `lastModified`, and `lastFetchedAt` for 9 sources in that channel.

Rollback:
- None (data deletion).

## Step 19 (Backfill Guard on Subsequent Fetches) - 2025-12-27 23:09:02 JST
Purpose: Prevent a follow-up fetch from backfilling historical items after the initial cap.
Commands:
- edit `apps/arkcore/src/rss.ts`
- edit `DECISIONS.md`

Result:
- Existing sources stop ingesting once a streak of already-seen items is detected.
- Prevents initial 3-item cap from being followed by a full backfill on next fetch.

Rollback:
- Revert changes in `apps/arkcore/src/rss.ts` and `DECISIONS.md`.

## Step 20 (X Fulltext Skip + RSS Fallback) - 2025-12-27 23:33:21 JST
Purpose: Avoid X full-text fetch failures by skipping full-text and using RSS content when available.
Commands:
- edit `apps/arkcore/src/digest.ts`
- edit `DECISIONS.md`

Result:
- Full-text fetch skipped for x.com/twitter.com URLs.
- RSS-provided content used for LLM input when X full-text is unavailable.

Rollback:
- Revert changes in `apps/arkcore/src/digest.ts` and `DECISIONS.md`.

## Step 21 (LLM Summary Extract Fallback) - 2025-12-27 23:44:24 JST
Purpose: Use partial LLM output when JSON is truncated mid-response.
Commands:
- edit `apps/arkcore/src/digest.ts`
- edit `DECISIONS.md`

Result:
- When JSON parsing fails, extract per-item summaries from partial text output.

Rollback:
- Revert changes in `apps/arkcore/src/digest.ts` and `DECISIONS.md`.

## Step 22 (LLM Max Tokens Config) - 2025-12-27 23:46:51 JST
Purpose: Make LLM max tokens configurable via .env.
Commands:
- edit `apps/arkcore/src/config.ts`
- edit `apps/arkcore/src/digest.ts`
- edit `.env.example`
- edit `DECISIONS.md`

Result:
- New `LLM_MAX_TOKENS` config (default 2000) controls LLM output length.

Rollback:
- Revert changes in `apps/arkcore/src/config.ts`, `apps/arkcore/src/digest.ts`, `.env.example`, and `DECISIONS.md`.

## Step 12 (LLM Fulltext Summary + JSON Repair + Git Init) - 2025-12-27 10:27:26 JST
Purpose: Switch LLM summaries to full-text-only input, add resilient JSON parsing, verify digest, and initialize git tracking.
Commands:
- edit `apps/arkcore/src/digest.ts`
- edit `apps/arkcore/src/config.ts`
- `docker compose up -d --build`
- `docker compose exec -T app env LOG_LEVEL=debug DIGEST_MAX_ITEMS=1 node --input-type=module -e '<buildDigestData smoke test>'`
- `docker compose exec -T app env LOG_LEVEL=debug DIGEST_MAX_ITEMS=5 node --input-type=module -e '<buildDigestData smoke test>'`
- `bash scripts/verify.sh`
- `git init`

Result:
- LLM uses full text only; RSS snippets ignored; missing full text shows fixed notice.
- LLM JSON parsing now repairs truncated output (escaped newlines/quotes and missing brackets).
- Verification succeeded: db ok, discord ok, digest ok (items=21), llm ok.
- Git repository initialized at `/home/zhixian/arkcore/.git`.
- Non-fatal `Could not parse CSS stylesheet` warnings still appear during verify.

Rollback:
- Revert edits in `apps/arkcore/src/digest.ts` and `apps/arkcore/src/config.ts`.
- Remove `.git` if needed.
- `docker compose down`

## Step 8 (Thread Item Embed Formatting) - 2025-12-24 22:02:12 JST
Purpose: Simplify thread item display to show summary only and remove URL line
Commands:
- edit `apps/arkcore/src/messaging.ts`

Result:
- item embeds show meta + summary only
- removed "Summary:" label and URL line
- cleaned common metadata prefixes from summaries

Rollback:
- Revert changes in `apps/arkcore/src/messaging.ts`

## Step 9 (RSSHub Error Detection + Failure Surfacing) - 2025-12-24 22:18:53 JST
Purpose: Detect RSSHub/Twitter API errors, block invalid X sources, and show failures in fetch/digest
Commands:
- edit `apps/arkcore/src/rss.ts`
- edit `apps/arkcore/src/commands.ts`
- edit `apps/arkcore/src/digest.ts`
- edit `apps/arkcore/src/messaging.ts`
- edit `apps/arkcore/src/scheduler.ts`
- edit `README.md`
- edit `DECISIONS.md`

Result:
- RSSHub error pages detected with readable reasons
- /source add x validates RSSHub and rejects missing Twitter API config
- /fetch now and digest overview surface failed sources

Rollback:
- Revert changes in the files listed above

## Step 10 (Add Others + Remove X) - 2025-12-24 22:44:33 JST
Purpose: Remove X-specific commands and add /source add others with RSSHub resolve
Commands:
- edit `apps/arkcore/src/commands.ts`
- edit `README.md`
- edit `DECISIONS.md`

Result:
- /source add x removed
- /source add others added with official RSS detection + RSSHub resolve
- docs updated to prefer official RSS and use RSSHub as fallback

Rollback:
- Revert changes in the files listed above

## Step 10a (Build Attempt) - 2025-12-24 22:45:01 JST
Purpose: Rebuild containers after adding /source add others
Commands:
- `sg docker -c "DOCKER_BUILDKIT=1 docker compose up -d --build"`

Result:
- status: failure (`Cannot open audit interface - aborting.`)

Rollback:
- No changes applied (build aborted)

## Step 10b (Verify Attempt) - 2025-12-24 22:48:05 JST
Purpose: Run verification after changes
Commands (user-reported):
- `sg docker -c "bash scripts/verify.sh"`

Result (user-reported):
- failed: `Error: Cannot find module '/app/dist/verify.js'`

Rollback:
- No changes applied (verify failed)

## Step 10c (Rebuild Success + App Restarting) - 2025-12-24 22:49:34 JST
Purpose: Rebuild containers and check dist contents
Commands (user-reported):
- `sg docker -c "DOCKER_BUILDKIT=1 docker compose up -d --build"`
- `sg docker -c "docker compose exec -T app ls -la dist"`

Result (user-reported):
- image built (~27.9s), app container recreated
- `docker compose exec` failed because app container is restarting

Rollback:
- `sg docker -c "docker compose down"`

## Step 10d (Build Cache Guard) - 2025-12-24 22:52:04 JST
Purpose: Ensure Docker build emits dist output even with cached tsbuildinfo
Commands:
- edit `Dockerfile`

Result:
- Added dist cache mount and guard to reset tsbuildinfo when dist is missing

Rollback:
- Revert changes in `Dockerfile`

## Step 10e (Fix dist cache mount) - 2025-12-24 22:53:55 JST
Purpose: Remove dist cache mount to ensure build outputs are copied into image
Commands:
- edit `Dockerfile`

Result:
- dist cache mount removed; build outputs stay in image layer

Rollback:
- Revert changes in `Dockerfile`

## Step 11 (GitHub URL Mapping for /source add others) - 2025-12-24 23:02:13 JST
Purpose: Map GitHub repo URLs to RSSHub commits feed without resolve
Commands:
- edit `apps/arkcore/src/commands.ts`

Result:
- GitHub repo URLs map to `/github/commits/{owner}/{repo}` feed via RSSHub
- Invalid GitHub URLs are rejected before other checks

Rollback:
- Revert changes in `apps/arkcore/src/commands.ts`

## Step 11a (Fetch Result Check) - 2025-12-24 23:21:14 JST
Purpose: Verify fetch output after GitHub mapping
Commands (user-reported):
- `/fetch now`

Result (user-reported):
- failed sources: `news.ycombinator.com (HTTP 404)`, `GitHub · ComposioHQ/awesome-claude-skills · commits (RSSHub error page)`
- new items: 0

Rollback:
- No changes applied (observation only)

## Step 12 (GitHub Official Atom Feed) - 2025-12-24 23:32:03 JST
Purpose: Use GitHub official Atom feeds for /source add others
Commands:
- edit `apps/arkcore/src/commands.ts`
- edit `README.md`

Result:
- GitHub repo URLs map to official commits Atom feed
- Reply includes instructions for releases/issues feeds
- RSSHub only used for non-GitHub URLs without official feeds

Rollback:
- Revert changes in `apps/arkcore/src/commands.ts` and `README.md`

## Step 11b (RSSHub/GitHub Debug Info) - 2025-12-24 23:27:03 JST
Purpose: Capture RSSHub log details and source list for GitHub/404 failures
Commands (user-reported):
- `docker compose logs --tail=200 rsshub`
- `/source list`

Result (user-reported):
- RSSHub returns 503 for `/github/commits/ComposioHQ/awesome-claude-skills` with NotFoundError
- HN source URL stored as `https://news.ycombinator.com/rss%20name:HN`
- GitHub source stored as `http://rsshub:1200/github/commits/ComposioHQ/awesome-claude-skills`

Rollback:
- No changes applied (observation only)

## AUTH REQUIRED - Swap File Setup (pending approval)
Time: 2025-12-24 21:57:22 JST
Purpose: Add a 2G swap file to improve build performance on low-memory VPS
Commands (no secrets):
- `sudo fallocate -l 2G /swapfile`
- `sudo chmod 600 /swapfile`
- `sudo mkswap /swapfile`
- `sudo swapon /swapfile`
- `sudo sh -c 'echo "/swapfile none swap sw 0 0" >> /etc/fstab'`

Rollback:
- `sudo swapoff /swapfile`
- `sudo rm -f /swapfile`
- remove the `/swapfile` line from `/etc/fstab`
