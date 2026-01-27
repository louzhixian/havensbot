# Observability Infrastructure Design

**Date**: 2026-01-14
**Status**: Implemented
**Author**: Design discussion with user

---

## Background

ArkCore is a Discord RSS aggregation bot (~5500 lines TypeScript) with the following issues:

1. **Uncontrolled data growth** - Item table grows indefinitely without archival
2. **Poor observability** - Only console.log, no structured logging or metrics
3. **LLM reliability issues** - No retry, fallback, or cost tracking
4. **Error handling gaps** - No systematic retry or recovery strategies

This design addresses items 1-4 from `docs/optimization-todos.md` (high priority stability/reliability improvements).

---

## Design Goals

1. **Observability**: Structured logging, metrics collection, and Discord-native monitoring
2. **Data Management**: Preserve all data while controlling active dataset size
3. **LLM Reliability**: Unified client with retry, fallback, and cost tracking
4. **Error Recovery**: Consistent retry strategies across all operations
5. **Zero Dependencies**: Use existing infrastructure (Postgres, Discord) without external services

---

## Key Design Decisions

### 1. Data Archival Strategy

**Decision**: Soft deletion with `archivedAt` timestamp

**Rationale**:
- Preserves all historical data (user requirement: "keep all data")
- Improves query performance by filtering active items
- Allows easy "unarchival" if needed
- Single table simplifies queries vs. separate archive table

**Implementation**:
```typescript
// Add to Item model
archivedAt DateTime?

// All business logic uses helper functions
getActiveItems(where) // filters archivedAt: null
getAllItems(where)    // includes archived for analysis
```

**Configuration**:
- `ARCHIVE_ENABLED` - toggle archival on/off
- `ARCHIVE_AFTER_DAYS` - retention period (default 180 days)
- `ARCHIVE_CHECK_CRON` - when to run (default 2 AM daily)

### 2. Observability Infrastructure

**Decision**: Pino + Postgres + Discord

**Rationale**:
- **Pino**: Fast, structured JSON logging with minimal overhead
- **Postgres**: Reuse existing DB for metrics storage (no Redis/external service)
- **Discord**: Native UI through slash commands and notifications

**Architecture**:
```
Application Code
      ↓
[Structured Logger] → Pino → Console/File
      ↓
[Metrics Recorder] → Prisma → ObservabilityMetric table
      ↓
[Alert System] → Alert Rules → SystemAlert table → Discord
      ↓
[Discord Commands] → Stats/Alerts queries → User
```

**Metrics Collection**:
- Automatic recording for: LLM calls, RSS fetches, Digest runs, Editorial runs
- Fields: type, operation, status, duration, metadata (JSON), cost
- Retention: 90 days (configurable)

**Alert Rules** (checked hourly):
1. LLM failure rate > 30% in last hour
2. Daily LLM cost > 80% of budget
3. RSS source fails 3 consecutive times
4. Database size exceeds threshold

### 3. LLM Client Abstraction

**Decision**: Unified LLM client with retry + fallback + cost tracking

**Current State**:
- Multiple LLM call sites with inconsistent error handling
- No token counting or cost tracking
- No fallback when LLM fails

**New Architecture**:
```typescript
class LlmClient {
  async call(request: LlmRequest): Promise<LlmResponse>
  async callWithFallback<T>(request, fallback): Promise<LlmResponse<T>>
}

// Automatic features:
- Exponential backoff retry (3 attempts)
- Token counting and cost estimation
- Metrics recording
- Failure rate tracking (simplified circuit breaker)
```

**Integration Points** (to be integrated):
- `digest.ts` - Digest summarization
- `editorial.ts` - Editorial report generation, item enrichment
- `deeper.ts` - Deep dive summaries

### 4. Retry Strategy

**Decision**: Unified retry utility with exponential backoff

**Implementation**:
```typescript
withRetry(operation, {
  maxAttempts: 3,
  initialDelay: 1000,
  backoffMultiplier: 2,
  shouldRetry: (error) => boolean
})
```

**Retryable Errors**:
- Network errors (ECONNRESET, ETIMEDOUT)
- 5xx server errors
- 429 rate limits

**Integration Points** (to be integrated):
- `rss.ts` - Feed fetching
- `messaging.ts` - Discord API calls

---

## Discord UI Design

### Commands

**`/stats`** - View system statistics
- `overview` - All metrics summary (24h window)
- `llm` - Detailed LLM usage by operation
- `errors` - Recent error records (default 10)
- `storage` - Database size and item counts
- `health` - System health check (DB, LLM, alerts)

**`/alerts`** - Manage alerts
- `list` - Show active alerts
- `resolve <id>` - Resolve an alert

**`/maintenance`** - Maintenance operations
- `archive` - Run archival process manually
- `archive-stats` - View archival statistics

### Notifications

**Alert Notifications**:
- Posted to `OBSERVABILITY_CHANNEL_ID`
- Critical alerts @mention `ALERT_MENTION_USER_ID`
- Includes severity emoji, type, message, timestamp

**Daily Report** (optional):
- Posted to observability channel
- Configurable time via `DAILY_REPORT_CRON`
- Summary of last 24h: LLM usage, RSS stats, errors, alerts

### Formatting

All Discord output uses:
- Emoji indicators for severity/status
- Code blocks for technical details
- Bullet lists for readability
- `<url>` syntax to suppress previews in reports

---

## Data Model Changes

### New Tables

**ObservabilityMetric**:
```prisma
model ObservabilityMetric {
  id          String   @id @default(cuid())
  createdAt   DateTime @default(now())
  type        MetricType  // llm, rss, digest, editorial, system
  operation   String      // e.g., "digest_summarize", "rss_fetch"
  status      MetricStatus // success, failure
  duration    Int?        // milliseconds
  metadata    Json?       // flexible data
  cost        Float?      // USD for LLM calls

  @@index([type, createdAt])
  @@index([status, createdAt])
  @@index([operation, createdAt])
}
```

**SystemAlert**:
```prisma
model SystemAlert {
  id          String   @id @default(cuid())
  createdAt   DateTime @default(now())
  resolvedAt  DateTime?
  type        AlertType     // llm_failures, cost_overrun, rss_failures, storage_warning
  severity    AlertSeverity // warning, critical
  message     String
  metadata    Json?

  @@index([resolvedAt, createdAt])
  @@index([severity, resolvedAt])
}
```

### Item Model Updates

```prisma
model Item {
  // ... existing fields
  archivedAt DateTime? // null = active, timestamp = archived

  @@index([createdAt])
  @@index([archivedAt]) // for archival queries
  @@index([sourceId, createdAt]) // optimize per-source queries
}
```

---

## Scheduled Tasks

**New Cron Jobs**:

1. **Alert Check** - `0 * * * *` (hourly)
   - Run all alert rules
   - Send notifications to Discord
   - Auto-resolve stale alerts (24h)

2. **Archival Process** - Configurable (default `0 2 * * *`)
   - Archive old items
   - Clean old metrics (90 days)
   - Clean resolved alerts (30 days)
   - Send archival notification

3. **Daily Report** - Configurable (default `0 9 * * *`)
   - Optional, controlled by `DAILY_REPORT_ENABLED`
   - Send stats summary to observability channel

**All tasks**:
- Use `recoverMissedExecutions: true`
- Respect `config.tz` for scheduling
- Use structured logger (not console.log)

---

## Configuration

### Required Environment Variables

```bash
# Observability
LOG_LEVEL=info                      # Pino log level
OBSERVABILITY_CHANNEL_ID=...        # Discord channel for stats/alerts
ALERT_MENTION_USER_ID=...           # User to @mention for critical alerts (optional)
LLM_DAILY_BUDGET=10.0               # Daily LLM cost budget (USD)
STORAGE_WARNING_GB=10               # Database size warning threshold

# Archival
ARCHIVE_ENABLED=true                # Enable/disable archival
ARCHIVE_AFTER_DAYS=180              # Archive items older than N days
ARCHIVE_CHECK_CRON=0 2 * * *       # When to run archival
METRICS_RETENTION_DAYS=90           # Keep metrics for N days

# Optional: Daily Report
DAILY_REPORT_ENABLED=true           # Enable daily stats report
DAILY_REPORT_CRON=0 9 * * *        # When to send report
```

---

## Implementation Phases

### Phase 1: Foundation (Completed)
- Database schema changes (migration)
- Structured logging (Pino)
- Metrics collection system
- Alert system (rules + storage)

### Phase 2: Discord Integration (Completed)
- Discord commands (/stats, /alerts, /maintenance)
- Discord formatters for all outputs
- Discord notifier for alerts and reports
- Scheduler integration

### Phase 3: Code Integration (Next)
- Update digest.ts, editorial.ts, deeper.ts → use LLM client
- Update rss.ts, messaging.ts → use retry utilities
- Replace console.log → structured logger

---

## Success Criteria

✅ **Observability**:
- All critical operations emit metrics
- Structured logs with proper context
- Discord commands provide system visibility
- Automatic alerting for failures and thresholds

✅ **Data Management**:
- Old data automatically archived
- Active dataset remains performant
- All historical data preserved
- Clear archival statistics

✅ **LLM Reliability**:
- Automatic retry on transient failures
- Fallback for all LLM operations
- Cost tracking and budget alerts
- Token usage visibility

✅ **Error Recovery**:
- Consistent retry behavior
- Failures don't cascade
- Recovery strategies documented
- Error metrics tracked

---

## Future Considerations

**Not Implemented** (deferred to later phases):
1. Multi-instance deployment (message queue, distributed locks)
2. Advanced caching (Redis)
3. Automated testing infrastructure
4. External monitoring integration (Prometheus/Grafana)

These are tracked in `docs/optimization-todos.md` as medium/low priority items.

---

## Related Documents

- `DECISIONS.md` - Architectural decision records
- `docs/optimization-todos.md` - Full optimization roadmap
- `docs/phase2-summary.md` - Implementation completion summary
- `RUNBOOK.md` - Operational procedures (to be updated)
