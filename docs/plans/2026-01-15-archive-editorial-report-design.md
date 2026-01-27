# Archive Editorial Report Feature

## Overview

Archive and remove the Editorial Report feature (daily editorial digest and item enrichment) from the codebase. The code will be preserved in a git branch for future reference.

## Motivation

The editorial report/digest is not providing sufficient value to justify its continued operation and maintenance.

## Scope

### Features to Remove

1. **Editorial Report** - Daily report sent to editorial channel with writing suggestions
2. **Item Enrichment** - LLM calls to generate writing suggestions for each RSS item

### Features to Preserve

- Editorial channel discussions (`editorial-discussion.ts`)
- Translation functionality (`editorial-translation.ts`)
- Deep dive analysis (`deeper.ts`)
- Normal RSS digest (unrelated to editorial)
- Database schema and historical data

## Implementation Plan

### Step 1: Create Archive Branch

```bash
git checkout -b archive/editorial-report
git checkout main
```

### Step 2: Code Removal

#### Files to Delete

| File | Reason |
|------|--------|
| `prompts/editorial.item_enrichment.prompt.md` | Enrichment prompt |
| `prompts/editorial.daily_report.prompt.md` | Report generation prompt |

#### Files to Modify

| File | Changes |
|------|---------|
| `editorial.ts` | Remove: `runEditorialEnrichment()`, `buildEditorialReport()`, `getEditorialStatus()`, `listEditorialSuggestions()`, and all related helper functions and types |
| `scheduler.ts` | Remove: `runEditorialReport()` function, enrichment cron job (lines 105-124), report call after digest (line 178) |
| `messaging.ts` | Remove: `sendEditorialReportThreaded()`, `sendEditorialFailureNotice()`, `sendEditorialSuggestionsThreaded()` |
| `commands.ts` | Remove: entire `/editorial` command handler (status, list, run, preview subcommands) |
| `config.ts` | Remove: `editorialEnrichEnabled`, `editorialWindowHours`, `editorialMaxItems`, `editorialTweetCount`, `editorialBlogCount`, `enrichMinContentChars` |
| `.env.example` | Remove: editorial-related environment variable documentation |

#### Database Schema (No Changes)

Keep the following for historical data preservation:
- `EditorialReport` table
- `Item.writingSuggestions` field
- `Item.contentQuality` field
- `Item.enrichedAt` field
- `Item.enrichErrorReason` field

### Step 3: Cleanup

- Update any documentation referencing editorial reports
- Remove unused imports after code deletion

## Rollback Plan

If the feature is needed again:
```bash
git checkout archive/editorial-report
# Cherry-pick or merge relevant commits back to main
```

## Verification

After removal:
1. Build passes: `npm run build`
2. Bot starts without errors
3. Normal RSS digest still works
4. Editorial channel discussions still work
5. Deep dive reactions still work
