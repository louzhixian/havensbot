# Observability Infrastructure Implementation Plan

**Date**: 2026-01-14
**Status**: ✅ Completed
**Execution Mode**: Direct implementation (retrospective plan)

---

## Overview

This plan implements the observability infrastructure designed in `2026-01-14-observability-design.md`. The implementation was completed in two phases, creating 10+ new modules and modifying 4 existing files.

---

## Phase 1: Foundation Infrastructure

### Step 1: Database Schema Changes

**Files**:
- `prisma/schema.prisma`
- `prisma/migrations/20260114011258_add_observability_tables/migration.sql`
- `.env.example`

**Changes**:
1. Add enums: `MetricType`, `MetricStatus`, `AlertType`, `AlertSeverity`
2. Add `ObservabilityMetric` model with indexes
3. Add `SystemAlert` model with indexes
4. Add `archivedAt DateTime?` to `Item` model
5. Add indexes: `Item.createdAt`, `Item.archivedAt`, `Item(sourceId, createdAt)`
6. Create migration SQL (manual due to local DATABASE_URL missing)
7. Update `.env.example` with new environment variables

**Validation**:
- ✅ User deployed to server successfully
- ✅ Migration applied without errors

### Step 2: Configuration System

**File**: `apps/arkcore/src/config.ts`

**Changes**:
1. Extend `AppConfig` type with observability fields:
   - `observabilityChannelId`, `alertMentionUserId`
   - `llmDailyBudget`, `storageWarningGb`
   - `dailyReportEnabled`, `dailyReportCron`
2. Extend with archival fields:
   - `archiveEnabled`, `archiveAfterDays`, `archiveCheckCron`
   - `metricsRetentionDays`
3. Update `loadConfig()` to parse new environment variables with defaults

### Step 3: Structured Logging

**File**: `apps/arkcore/src/observability/logger.ts`

**Implementation**:
```typescript
import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  formatters: { level: (label) => ({ level: label }) },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: "arkcore" },
});

export const createLogger = (context: Record<string, any>) => {
  return logger.child(context);
};
```

**Dependencies**: Add `pino: ^9.5.0` to `package.json`

### Step 4: Metrics Collection

**File**: `apps/arkcore/src/observability/metrics.ts`

**Core Functions**:
1. `recordMetric(data)` - Single metric recording
2. `recordMetricsBatch(data[])` - Bulk recording
3. Integration with structured logger

**Metric Types**:
- `llm` - LLM API calls
- `rss` - RSS feed fetches
- `digest` - Digest generation
- `editorial` - Editorial operations
- `system` - System events (archival, etc.)

### Step 5: Alert System

**File**: `apps/arkcore/src/observability/alerts.ts`

**Core Functions**:
1. `triggerAlert(type, severity, message, metadata)` - Create alert with deduplication
2. `resolveAlert(alertId)` - Mark alert resolved
3. `getActiveAlerts()` - Query unresolved alerts
4. `autoResolveStaleAlerts()` - Auto-resolve after 24h
5. `cleanOldAlerts()` - Delete resolved alerts > 30 days

**Deduplication**: Same type + message within 24h = skip duplicate

### Step 6: Alert Rules

**File**: `apps/arkcore/src/observability/alert-rules.ts`

**Rules Implemented**:
1. `checkLlmFailureRate()` - >30% failures in last hour
2. `checkLlmCost()` - >80% of daily budget
3. `checkRssFailures()` - 3+ consecutive failures per source
4. `checkStorageUsage()` - Database size exceeds threshold
5. `runAllAlertRules()` - Orchestrates all checks

**Scheduler Integration**: Called hourly via cron

### Step 7: Statistics Queries

**File**: `apps/arkcore/src/observability/stats.ts`

**Functions**:
1. `getStatsOverview(config)` - 24h summary of all operations
2. `getLlmDetailedStats()` - LLM usage grouped by operation
3. `getRecentErrors(limit)` - Last N error records
4. `getStorageStats()` - Database size and item counts
5. `getHealthStatus()` - DB connection, LLM status, active alerts

---

## Phase 2: LLM and Retry Infrastructure

### Step 8: LLM Cost Estimation

**File**: `apps/arkcore/src/llm/cost-estimator.ts`

**Implementation**:
1. Pricing table for common models:
   - GPT-4, GPT-4 Turbo, GPT-3.5 Turbo
   - Gemini Pro, Gemini Flash
   - Claude Opus, Sonnet, Haiku
2. `getModelPricing(model)` - Returns input/output per-1K-token pricing
3. `estimateCost(model, inputTokens, outputTokens)` - Calculate USD cost

### Step 9: Unified LLM Client

**File**: `apps/arkcore/src/llm/client.ts`

**Key Features**:
1. `LlmClient` class with singleton pattern
2. `call(request)` - Basic LLM call with retry
3. `callWithFallback(request, fallback)` - Auto-fallback on failure
4. Automatic metrics recording
5. Token counting and cost calculation
6. Failure rate tracking (simplified circuit breaker)
7. Integration with retry utility

**Not Yet Integrated**: To be added to `digest.ts`, `editorial.ts`, `deeper.ts`

### Step 10: Retry Utilities

**File**: `apps/arkcore/src/utils/retry-utils.ts`

**Implementation**:
```typescript
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts?: number;           // default 3
    initialDelay?: number;          // default 1000ms
    backoffMultiplier?: number;     // default 2
    shouldRetry?: (error) => boolean;
  }
): Promise<T>
```

**Retryable Errors**:
- Network: ECONNRESET, ETIMEDOUT, ENOTFOUND
- HTTP: 5xx, 429
- Custom predicate via `shouldRetry`

**Not Yet Integrated**: To be added to `rss.ts`, `messaging.ts`

### Step 11: Database Query Helpers

**File**: `apps/arkcore/src/utils/db-helpers.ts`

**Functions**:
1. `getActiveItems(where)` - Only non-archived items
2. `getAllItems(where)` - Include archived
3. `countActiveItems(where)` - Count non-archived
4. `countAllItems(where)` - Count all
5. `findFirstActiveItem(args)` - Query active item
6. `findManyActiveItems(args)` - Query many active items

**Purpose**: Ensure business logic excludes archived data by default

---

## Phase 3: Archival System

### Step 12: Archival Core

**File**: `apps/arkcore/src/archival/archiver.ts`

**Functions**:
1. `archiveOldItems(config)` - Set `archivedAt` for old items
2. `cleanOldMetrics(config)` - Hard delete metrics > retention period
3. `runArchivalProcess(config)` - Orchestrate full archival:
   - Archive items
   - Clean metrics
   - Clean alerts
   - Record metrics
   - Log results

**Scheduler Integration**: Called daily (configurable) via cron

### Step 13: Archival Statistics

**File**: `apps/arkcore/src/archival/stats.ts`

**Function**: `getArchivalStats(config)`

**Returns**:
- Total/active/archived item counts
- Archival rate percentage
- Oldest active item date
- Newest archived item date
- Estimated next archival date and item count

---

## Phase 4: Discord Integration

### Step 14: Discord Formatters

**File**: `apps/arkcore/src/observability/discord-formatter.ts`

**Functions**:
1. `formatStatsOverview(stats)` - Format overview with emojis
2. `formatLlmStats(stats)` - Detailed LLM usage table
3. `formatRecentErrors(errors)` - Error list with code blocks
4. `formatStorageStats(stats)` - Storage and item counts
5. `formatHealthStatus(health)` - Health check results
6. `formatAlertMessage(alert)` - Single alert with severity emoji
7. `formatActiveAlerts(alerts)` - List of unresolved alerts
8. `formatArchivalStats(stats)` - Archival timeline

**Style Guidelines**:
- Use emoji indicators (✅ ⚠️ ❌ 📊 💰 📦)
- Code blocks for technical data
- Bullet lists for readability
- Keep messages under Discord's 2000 char limit

### Step 15: Discord Notifier

**File**: `apps/arkcore/src/observability/discord-notifier.ts`

**Functions**:
1. `sendAlertToDiscord(alert, config, client)` - Send alert notification
   - @mention for critical alerts
   - Post to observability channel
2. `sendDailyReport(config, client)` - Send 24h stats summary
3. `sendArchivalNotification(result, config, client)` - Post archival completion

### Step 16: Discord Commands

**File**: `apps/arkcore/src/commands.ts`

**Changes**:
1. Import all stats, alert, and archival functions
2. Add command definitions:
   - `/stats` with 5 subcommands
   - `/alerts` with 2 subcommands
   - `/maintenance` with 2 subcommands
3. Add handler logic in `handleInteraction()`:
   - Defer replies for all commands (ephemeral)
   - Query data, format, send response
   - Error handling for resolve and archive operations

**Auto-Registration**: Commands registered via existing `commandData` array

### Step 17: Scheduler Integration

**File**: `apps/arkcore/src/scheduler.ts`

**Changes**:
1. Import new modules:
   - `runAllAlertRules` from alert-rules
   - `sendDailyReport` from discord-notifier
   - `runArchivalProcess` from archiver
   - `logger` for structured logging
2. Add three new cron jobs:
   - Alert check: `0 * * * *` (hourly)
   - Archival: `config.archiveCheckCron` (conditional on `ARCHIVE_ENABLED`)
   - Daily report: `config.dailyReportCron` (conditional on `DAILY_REPORT_ENABLED`)
3. Replace some `console.log` with `logger.info/error`

**Note**: Existing console.log preserved in digest/editorial for now (Phase 3 will replace)

---

## Phase 5: Documentation

### Step 18: Update Documentation

**Files Updated**:
1. `DECISIONS.md` - Add 9 new decision records:
   - Observability infrastructure choice
   - Metrics collection strategy
   - Alert rules and notification
   - LLM client abstraction
   - Retry strategy
   - Data archival approach
   - Metrics retention policy
   - Discord observability channel
   - Discord command integration

2. `docs/optimization-todos.md` - Mark items 1-4 as completed:
   - ✅ Data archival with soft deletion
   - ✅ Observability infrastructure
   - ✅ LLM reliability improvements
   - ✅ Error handling and retry
   - Add "待集成" sections for pending work

3. Create `docs/phase2-summary.md` - Comprehensive completion summary

---

## Deployment Steps

### Prerequisites

1. **Database Migration**:
   ```bash
   # On server
   npx prisma migrate deploy
   ```

2. **Environment Variables**:
   Add to `.env` (see `.env.example` for all options):
   ```bash
   OBSERVABILITY_CHANNEL_ID=your_channel_id
   LLM_DAILY_BUDGET=10.0
   ARCHIVE_ENABLED=true
   ARCHIVE_AFTER_DAYS=180
   # ... etc
   ```

3. **Install Dependencies**:
   ```bash
   npm install  # Adds pino@^9.5.0
   ```

### Deployment

1. **Push to Repository**:
   ```bash
   git push origin main
   ```

2. **Deploy to Server**:
   - Pull latest code
   - Run migrations (if not done in Phase 1)
   - Update environment variables
   - Restart application

3. **Verify Commands**:
   - Discord will auto-register new commands on restart
   - Test `/stats overview`
   - Test `/alerts list`
   - Test `/maintenance archive-stats`

### Post-Deployment Monitoring

1. **Check Logs**:
   - Verify structured logging is working
   - Check scheduler task logs

2. **Verify Metrics**:
   - Run `/stats overview` after a few hours
   - Confirm LLM metrics are being recorded

3. **Test Alerts**:
   - Wait for hourly alert check
   - Manually trigger alert conditions if needed

4. **Verify Archival**:
   - Run `/maintenance archive-stats`
   - Check estimated archival date

---

## Integration Roadmap (Phase 3)

### Pending Integrations

**LLM Client** (3 files):
1. `apps/arkcore/src/digest.ts`
   - Replace direct OpenAI calls with `LlmClient`
   - Use `callWithFallback()` for summarization
   - Remove manual error handling (handled by client)

2. `apps/arkcore/src/editorial.ts`
   - Update report generation LLM calls
   - Update item enrichment LLM calls
   - Use automatic retry and metrics

3. `apps/arkcore/src/deeper.ts`
   - Update deep dive LLM calls
   - Use automatic cost tracking

**Retry Mechanism** (2 files):
1. `apps/arkcore/src/rss.ts`
   - Wrap `fetch()` calls in `withRetry()`
   - Add RSSHub-specific retry logic

2. `apps/arkcore/src/messaging.ts`
   - Wrap Discord API calls in `withRetry()`
   - Handle rate limits properly

**Logging Migration**:
- Replace all `console.log/error/warn` with structured logger
- Add proper context to all log calls

---

## Testing Checklist

### Unit Testing (Future)
- [ ] Retry utilities with mock failures
- [ ] Cost estimation accuracy
- [ ] Alert deduplication logic
- [ ] Archival date calculations

### Integration Testing (Manual)
- [x] Database migration successful
- [x] Commands register in Discord
- [ ] Stats commands return correct data
- [ ] Alerts trigger correctly
- [ ] Archival process completes
- [ ] Daily report sends successfully

### End-to-End Testing
- [ ] Full LLM call with metrics recording
- [ ] RSS fetch failure triggers alert
- [ ] Cost threshold alert fires
- [ ] Archival runs on schedule
- [ ] Commands work in production

---

## Git History

**Commits Created**:
1. `20260114011258_add_observability_tables` - Database migration (Phase 1)
2. `fafc336` - Main implementation (14 files, 2135+ lines)
3. `f2a22dd` - Phase 2 summary documentation

**Files Created** (10 new modules):
```
apps/arkcore/src/
├── archival/
│   ├── archiver.ts
│   └── stats.ts
├── llm/
│   ├── client.ts
│   └── cost-estimator.ts
├── observability/
│   ├── alert-rules.ts
│   ├── alerts.ts
│   ├── discord-formatter.ts
│   ├── discord-notifier.ts
│   └── stats.ts
└── utils/
    └── db-helpers.ts
```

**Files Modified** (4 existing):
- `apps/arkcore/src/commands.ts` - Added 3 commands
- `apps/arkcore/src/scheduler.ts` - Added 3 cron jobs
- `DECISIONS.md` - Added 9 decision records
- `docs/optimization-todos.md` - Updated completion status

---

## Success Metrics

### Immediate (Day 1)
- ✅ All modules compile without errors
- ✅ Database migration successful
- ✅ Commands registered in Discord
- [ ] At least one metric recorded for each type

### Short-term (Week 1)
- [ ] No critical alerts fired incorrectly
- [ ] Daily report sending successfully
- [ ] LLM cost tracking showing accurate data
- [ ] Archival process running on schedule

### Medium-term (Month 1)
- [ ] Archival has processed items correctly
- [ ] Storage growth is controlled
- [ ] Alert fatigue is minimal (no spam)
- [ ] Cost tracking helps optimize LLM usage

---

## Lessons Learned

**What Went Well**:
1. Soft deletion design preserves data while improving performance
2. Discord-native UI avoids external service dependencies
3. Modular architecture keeps concerns separated
4. Structured logging provides better debugging

**What Could Be Improved**:
1. Should have created implementation plan before coding
2. Could have used git worktree for isolation
3. Testing strategy needs formalization
4. Migration generation required manual intervention

**For Next Phase**:
1. ✅ Use `superpowers:writing-plans` before implementation
2. ✅ Use `superpowers:using-git-worktrees` for isolation
3. ✅ Use `superpowers:executing-plans` for structured execution
4. Consider adding automated tests alongside features

---

## Related Documents

- `docs/plans/2026-01-14-observability-design.md` - Design specification
- `docs/phase2-summary.md` - Implementation completion summary
- `DECISIONS.md` - Architectural decisions
- `docs/optimization-todos.md` - Full optimization roadmap
