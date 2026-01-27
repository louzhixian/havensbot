# Remove RSSHub Dependency

## Overview

Remove self-hosted RSSHub and all related code from ArkCore. The feature is underutilized (only 1 Telegram channel out of 22 sources) and adds unnecessary complexity.

## Motivation

- Self-hosted RSSHub only serves 1 source (`groupdigest` Telegram channel)
- Other 21 sources use official RSS or third-party RSS services
- Maintenance overhead not justified by usage

## Implementation Plan

### Step 1: Server Operations

```bash
# Delete the only RSSHub-dependent source
ssh arkcore "cd ~/arkcore && docker compose exec -T postgres psql -U arkcore -d arkcore -c \"DELETE FROM \\\"Source\\\" WHERE url LIKE '%rsshub:1200%';\""

# Stop and remove RSSHub container
ssh arkcore "cd ~/arkcore && docker compose stop rsshub && docker compose rm -f rsshub"
```

### Step 2: Code Changes

| File | Changes |
|------|---------|
| `docker-compose.yml` | Remove `rsshub` service and dependency from `app` |
| `config.ts` | Remove `rsshubBaseUrl` config |
| `.env.example` | Remove `RSSHUB_BASE_URL` |
| `source-handlers.ts` | Remove Telegram handler, remove RSSHub resolve from `/source add others` |
| `source-utils.ts` | Remove `tryResolveWithRssHub()` |
| `rss.ts` | Remove `detectRssHubError()` |
| `commands.ts` | Remove `/source add telegram` subcommand |

### Step 3: Behavior Changes

**Before:**
- `/source add telegram` - Add Telegram channel via RSSHub
- `/source add others` - Try official RSS, fallback to RSSHub resolve

**After:**
- `/source add telegram` - Removed
- `/source add others` - Only official RSS detection, no RSSHub fallback (returns error if no RSS found)

### Step 4: Documentation Updates

- Update README.md
- Update relevant docs

### Step 5: Deploy

```bash
ssh arkcore "cd ~/arkcore && git pull && docker compose up -d --build app"
```

## Rollback Plan

If RSSHub is needed again:
1. Re-add service to `docker-compose.yml`
2. Revert code changes from git history
3. Configure `RSSHUB_BASE_URL` in `.env`
