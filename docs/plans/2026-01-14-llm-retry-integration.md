# LLM Client and Retry Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate the new LLM client and retry utilities into existing codebase to improve reliability, observability, and consistency.

**Architecture:** Replace direct LLM API calls with the unified `LlmClient` (which includes automatic retry, metrics recording, cost tracking). Replace custom retry logic and add retry to Discord API calls using the `withRetry` utility (which records metrics and uses exponential backoff).

**Tech Stack:** TypeScript, Pino logging, Prisma metrics, existing LLM/retry utilities

---

## Prerequisites

**Verify these files exist:**
- `apps/arkcore/src/llm/client.ts` - Unified LLM client
- `apps/arkcore/src/llm/cost-estimator.ts` - Cost estimation
- `apps/arkcore/src/utils/retry-utils.ts` - Retry utility
- `apps/arkcore/src/observability/logger.ts` - Structured logging
- `apps/arkcore/src/observability/metrics.ts` - Metrics recording

**Files to modify:**
- `apps/arkcore/src/digest.ts` - LLM integration
- `apps/arkcore/src/editorial.ts` - LLM integration
- `apps/arkcore/src/deeper.ts` - LLM integration
- `apps/arkcore/src/rss.ts` - Retry integration
- `apps/arkcore/src/messaging.ts` - Retry integration

---

## Task 1: Integrate LLM Client into digest.ts

**Files:**
- Modify: `apps/arkcore/src/digest.ts`

**Current State:**
- Line 380-398: Direct fetch call to LLM API
- No metrics recording for LLM calls
- No cost tracking
- Manual error handling

**Target State:**
- Use `LlmClient` for all LLM calls
- Automatic metrics, cost tracking, retry
- Fallback handled by client

### Step 1: Add imports

At the top of `digest.ts`, add after existing imports:

```typescript
import { LlmClient } from "./llm/client.js";
```

### Step 2: Initialize LLM client

After line 66 (where `const LLM_BATCH_SIZE = 1;` is), add:

```typescript
const llmClient = LlmClient.getInstance();
```

### Step 3: Replace callLlmForDigest function

Find the function starting around line 350 (the function that calls fetch to LLM).

**Current signature:**
```typescript
const callLlmForDigest = async (
  config: AppConfig,
  items: InternalItem[],
  maxSummaryChars: number
): Promise<Map<string, string> | null> => {
```

**Replace the entire function body with:**

```typescript
const callLlmForDigest = async (
  config: AppConfig,
  items: InternalItem[],
  maxSummaryChars: number
): Promise<Map<string, string> | null> => {
  if (!config.llmApiKey || !config.llmModel) return null;
  if (items.length === 0) return null;

  const payloadItems = items.map((item) => ({
    url: item.url,
    title: item.title,
    source: item.sourceName,
    content: item.content,
  }));

  const systemPrompt =
    "Return JSON only (no markdown fences). Escape newlines in strings as \\n. Summarize items using provided content. Do not repeat titles. For each item summary: 用 一句话 告诉我：这条内容为什么值得关注 / 争论点是什么？ Keep each summary under the configured character limit.";

  const userPrompt = `Output format:\n{\n  "items": [{"url":"...","summary":"..."}]\n}\n\nSummary instruction: 用 一句话 告诉我：这条内容为什么值得关注 / 争论点是什么？\nSummary max chars: ${maxSummaryChars}\n\nItems:\n${JSON.stringify(
    payloadItems
  )}`;

  const response = await llmClient.callWithFallback(
    {
      provider: config.llmProvider as "openai_compat",
      apiKey: config.llmApiKey!,
      model: config.llmModel!,
      baseUrl: config.llmBaseUrl,
      systemPrompt,
      userPrompt,
      temperature: 0.3,
      maxTokens: config.llmMaxTokens,
      operation: "digest_summarize",
    },
    () => null // Fallback returns null
  );

  if (!response.data) {
    debugLog("llm-null-response", { items: items.length });
    return null;
  }

  const content = response.data;

  try {
    const parsed = JSON.parse(content) as {
      items?: Array<{ url: string; summary: string }>;
    };
    if (!parsed.items || !Array.isArray(parsed.items)) {
      throw new Error("Invalid JSON structure");
    }

    const resultMap = new Map<string, string>();
    for (const { url, summary } of parsed.items) {
      if (url && summary) {
        resultMap.set(url, summary);
      }
    }

    debugLog("llm-success", {
      requestedCount: items.length,
      returnedCount: resultMap.size,
    });
    return resultMap;
  } catch (parseError) {
    debugLog("llm-parse-error", {
      error: parseError instanceof Error ? parseError.message : String(parseError),
      content: content.substring(0, 200),
    });
    return null;
  }
};
```

### Step 4: Remove unused imports

Remove these lines if present (they're no longer needed):

```typescript
import { buildOpenAiCompatUrl } from "./utils.js";
```

Actually, check if `buildOpenAiCompatUrl` is used elsewhere in the file first.

### Step 5: Test manually

Run the application and trigger a digest:

```bash
docker-compose build app
docker-compose up -d
docker-compose logs app -f
```

In Discord, run: `/digest run`

Expected: Digest generates successfully with LLM summaries

### Step 6: Verify metrics

After running digest, check metrics in Discord:

```
/stats llm
```

Expected: See "digest_summarize" operation in LLM stats

### Step 7: Commit

```bash
git add apps/arkcore/src/digest.ts
git commit -m "feat(digest): integrate unified LLM client

Replace direct fetch calls with LlmClient for:
- Automatic retry with exponential backoff
- Metrics recording (operation: digest_summarize)
- Cost tracking
- Fallback handling

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 2: Integrate LLM Client into editorial.ts

**Files:**
- Modify: `apps/arkcore/src/editorial.ts`

**Current State:**
- Multiple LLM call sites for different operations
- Direct fetch calls
- No unified metrics/cost tracking

### Step 1: Add imports

At the top of `editorial.ts`, add:

```typescript
import { LlmClient } from "./llm/client.js";
```

### Step 2: Initialize LLM client

Near the top of the file (after imports), add:

```typescript
const llmClient = LlmClient.getInstance();
```

### Step 3: Find all LLM call sites

Search the file for patterns like:
- `buildOpenAiCompatUrl`
- `fetch(endpoint`
- Lines containing `llmApiKey` or `llmModel`

Typical locations:
- Editorial report generation (main LLM call)
- Item enrichment (if separate LLM calls)

### Step 4: Replace first LLM call site

For the main editorial report generation function, find the fetch call and replace with:

```typescript
const response = await llmClient.callWithFallback(
  {
    provider: config.llmProvider as "openai_compat",
    apiKey: config.llmApiKey!,
    model: config.llmModel!,
    baseUrl: config.llmBaseUrl,
    systemPrompt: /* existing system prompt */,
    userPrompt: /* existing user prompt */,
    temperature: /* existing temperature or 0.3 */,
    maxTokens: config.llmMaxTokens,
    operation: "editorial_report",
  },
  () => {
    throw new Error("Editorial report generation failed");
  }
);

const content = response.data;
```

### Step 5: Replace item enrichment LLM calls

If there's a separate function for enriching items, replace similarly with operation name `"editorial_enrich"`.

### Step 6: Test manually

```bash
docker-compose build app
docker-compose up -d
```

In Discord, run: `/editorial run`

Expected: Editorial report generates successfully

### Step 7: Verify metrics

```
/stats llm
```

Expected: See "editorial_report" and/or "editorial_enrich" operations

### Step 8: Commit

```bash
git add apps/arkcore/src/editorial.ts
git commit -m "feat(editorial): integrate unified LLM client

Replace direct fetch calls with LlmClient for editorial operations.
Adds automatic retry, metrics, and cost tracking.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 3: Integrate LLM Client into deeper.ts

**Files:**
- Modify: `apps/arkcore/src/deeper.ts`

**Current State:**
- Direct LLM API calls
- No metrics/cost tracking

### Step 1: Add imports

At the top of `deeper.ts`, add:

```typescript
import { LlmClient } from "./llm/client.js";
```

### Step 2: Initialize LLM client

```typescript
const llmClient = LlmClient.getInstance();
```

### Step 3: Find LLM call site

Search for `buildOpenAiCompatUrl` or `fetch` calls in the file.

### Step 4: Replace LLM call

Replace the fetch call with:

```typescript
const response = await llmClient.callWithFallback(
  {
    provider: config.llmProvider as "openai_compat",
    apiKey: config.llmApiKey!,
    model: config.llmModel!,
    baseUrl: config.llmBaseUrl,
    systemPrompt: /* existing system prompt */,
    userPrompt: /* existing user prompt */,
    temperature: /* existing temperature */,
    maxTokens: config.llmMaxTokens,
    operation: "deeper_analyze",
  },
  () => {
    throw new Error("Deep analysis failed");
  }
);

const content = response.data;
```

### Step 5: Test manually

Test the deeper analysis functionality (if there's a command or it runs automatically).

Expected: Works as before

### Step 6: Verify metrics

```
/stats llm
```

Expected: See "deeper_analyze" operation if it was triggered

### Step 7: Commit

```bash
git add apps/arkcore/src/deeper.ts
git commit -m "feat(deeper): integrate unified LLM client

Replace direct fetch calls with LlmClient for deep analysis.
Adds automatic retry, metrics, and cost tracking.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 4: Integrate Retry Utility into rss.ts

**Files:**
- Modify: `apps/arkcore/src/rss.ts`

**Current State:**
- Custom `fetchWithRetry` function (lines 109-145)
- No metrics recording for retries
- Hardcoded retry logic

**Target State:**
- Use `withRetry` utility from retry-utils.ts
- Automatic metrics recording
- Consistent retry behavior across codebase

### Step 1: Add imports

At the top of `rss.ts`, add:

```typescript
import { withRetry } from "./utils/retry-utils.js";
import { logger } from "./observability/logger.js";
```

### Step 2: Remove custom fetchWithRetry function

Delete the entire `fetchWithRetry` function (lines 109-145).

### Step 3: Update fetchFeed function

Find the `fetchFeed` function (around line 147). Replace the call to `fetchWithRetry` with:

```typescript
const fetchFeed = async (source: Source): Promise<FetchResult> => {
  const headers: Record<string, string> = {
    "User-Agent": "ArkCore/0.1 (+https://example.invalid)",
    Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
  };

  if (source.etag) headers["If-None-Match"] = source.etag;
  if (source.lastModified) headers["If-Modified-Since"] = source.lastModified;

  const response = await withRetry(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      try {
        const res = await fetch(source.url, {
          method: "GET",
          headers,
          redirect: "follow",
          signal: controller.signal,
        });
        clearTimeout(timeout);

        // Still throw on 5xx to trigger retry
        if (res.status >= 500) {
          throw new Error(`Server error: ${res.status}`);
        }

        return res;
      } catch (error) {
        clearTimeout(timeout);
        throw error;
      }
    },
    {
      maxAttempts: 3,
      initialDelay: 1000,
      backoffMultiplier: 2,
      shouldRetry: (error) => {
        // Retry on network errors and 5xx
        if (error instanceof Error) {
          return (
            error.message.includes("Server error") ||
            error.message.includes("fetch failed") ||
            error.message.includes("aborted")
          );
        }
        return false;
      },
    }
  );

  // Rest of the function remains the same...
```

### Step 4: Update sleep import

Make sure there's still a `sleep` function if used elsewhere in the file, or import it from utils if needed.

### Step 5: Test RSS fetch

```bash
docker-compose build app
docker-compose up -d
```

Wait for automatic RSS fetch or trigger manually: `/fetch now`

Expected: RSS fetches work as before

### Step 6: Verify retry behavior

To test retry, you could temporarily make a source URL point to an unreliable endpoint, or wait for a natural failure.

Check logs for retry behavior:

```bash
docker-compose logs app | grep "retry"
```

### Step 7: Commit

```bash
git add apps/arkcore/src/rss.ts
git commit -m "feat(rss): replace custom retry with unified utility

Replace custom fetchWithRetry with withRetry utility:
- Consistent retry behavior across codebase
- Automatic metrics recording
- Better error handling

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 5: Integrate Retry Utility into messaging.ts

**Files:**
- Modify: `apps/arkcore/src/messaging.ts`

**Current State:**
- Direct Discord API calls without retry
- Vulnerable to rate limits and transient failures

**Target State:**
- Wrap Discord API calls in `withRetry`
- Automatic retry on transient failures
- Rate limit handling

### Step 1: Add imports

At the top of `messaging.ts`, add:

```typescript
import { withRetry } from "./utils/retry-utils.js";
import { logger } from "./observability/logger.js";
```

### Step 2: Create helper function

Add this helper function near the top of the file (after imports):

```typescript
/**
 * Wrap Discord API calls with retry logic
 */
async function retryDiscordCall<T>(
  operation: () => Promise<T>,
  operationName: string
): Promise<T> {
  return withRetry(operation, {
    maxAttempts: 3,
    initialDelay: 1000,
    backoffMultiplier: 2,
    shouldRetry: (error) => {
      // Retry on rate limits and transient errors
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        return (
          message.includes("rate limit") ||
          message.includes("timeout") ||
          message.includes("econnreset") ||
          message.includes("503") ||
          message.includes("502")
        );
      }
      return false;
    },
  }).catch((error) => {
    logger.error(
      { error, operation: operationName },
      "Discord API call failed after retries"
    );
    throw error;
  });
}
```

### Step 3: Wrap critical Discord API calls

Find the most critical API calls (usually `channel.send`, `message.edit`, `thread.send`) and wrap them.

**Example - wrapping channel.send:**

Before:
```typescript
await channel.send({ embeds: [overviewEmbed] });
```

After:
```typescript
await retryDiscordCall(
  () => channel.send({ embeds: [overviewEmbed] }),
  "send_digest_overview"
);
```

### Step 4: Wrap key operations systematically

Go through the file and wrap these operations:
- `sendDigestOverview` - channel.send calls
- `sendDigestThreaded` - channel.send, thread.send calls
- `sendEditorialReportThreaded` - channel.send, thread.send calls
- `sendEditorialSuggestionsThreaded` - channel.send, thread.send calls
- Any other public functions that make Discord API calls

**Important:** Don't wrap every single call - focus on:
1. Initial message sends (most important)
2. Thread creation
3. Critical embeds/reports

Don't wrap:
- Follow-up messages in a tight loop (they'll inherit parent retry)
- Non-critical operations
- Operations where failure is acceptable

### Step 5: Test messaging

```bash
docker-compose build app
docker-compose up -d
```

Trigger various operations:
- `/digest run`
- `/editorial run`

Expected: Messages send successfully, with retry on transient failures

### Step 6: Monitor for rate limits

Check logs to see if rate limit retries are working:

```bash
docker-compose logs app | grep -i "rate limit"
```

### Step 7: Commit

```bash
git add apps/arkcore/src/messaging.ts
git commit -m "feat(messaging): add retry logic to Discord API calls

Wrap critical Discord API calls with retry utility:
- Automatic retry on rate limits and transient errors
- Better resilience for message sending
- Consistent error handling

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 6: Update Documentation

**Files:**
- Modify: `docs/optimization-todos.md`

### Step 1: Update optimization-todos.md

Mark the pending integration tasks as complete:

Find the "待集成" sections and update:

**LLM Client Integration:**
```markdown
**待集成**
- [x] 更新 digest.ts 使用新 LLM 客户端
- [x] 更新 editorial.ts 使用新 LLM 客户端
- [x] 更新 deeper.ts 使用新 LLM 客户端
```

**Retry Mechanism Integration:**
```markdown
**待集成**
- [x] 更新 rss.ts 集成重试机制
- [x] 更新 messaging.ts 集成重试机制
```

### Step 2: Add integration summary

At the top of the file, update the status:

```markdown
Status: ✅ **Phase 2 Completed** - LLM Client and Retry Integration Complete
```

### Step 3: Commit

```bash
git add docs/optimization-todos.md
git commit -m "docs: mark phase 2 integrations as complete

All pending integrations finished:
- LLM client integrated into digest, editorial, deeper
- Retry utility integrated into rss, messaging

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 7: Final Verification

### Step 1: Run full system test

```bash
# Rebuild and restart
docker-compose build app
docker-compose up -d

# Watch logs
docker-compose logs app -f
```

### Step 2: Test all integrated features

In Discord, run:

1. `/fetch all` - Test RSS with retry
2. `/digest run` - Test digest with LLM client
3. `/editorial run` - Test editorial with LLM client
4. `/stats llm` - Verify LLM metrics are recorded
5. `/stats overview` - Verify system is healthy

### Step 3: Verify metrics collection

Check that all operations are recording metrics:

```
/stats llm
```

Expected operations to see:
- `digest_summarize`
- `editorial_report`
- `editorial_enrich` (if applicable)
- `deeper_analyze` (if triggered)

### Step 4: Check logs for structure

```bash
docker-compose logs app | grep '"level":"info"' | tail -20
```

Expected: Structured JSON logs with proper context

### Step 5: Verify cost tracking

```
/stats llm
```

Expected: Total cost should be calculated and displayed

### Step 6: Create summary document

Create `docs/phase2-integration-complete.md`:

```markdown
# Phase 2 Integration Complete

**Date:** 2026-01-14
**Status:** ✅ Complete

## Summary

Successfully integrated the observability infrastructure into the existing codebase:

### LLM Client Integration
- ✅ digest.ts - Using LlmClient for summarization
- ✅ editorial.ts - Using LlmClient for report generation
- ✅ deeper.ts - Using LlmClient for deep analysis

**Benefits:**
- Automatic retry with exponential backoff
- Metrics recording for all LLM calls
- Cost tracking per operation
- Consistent error handling

### Retry Utility Integration
- ✅ rss.ts - Replaced custom retry with withRetry
- ✅ messaging.ts - Added retry to Discord API calls

**Benefits:**
- Consistent retry behavior across codebase
- Metrics recording for failures
- Better handling of transient errors
- Rate limit resilience

## Metrics

After integration, the following metrics are now tracked:
- LLM calls by operation type
- LLM costs per operation
- Retry attempts and failures
- Success rates

## Testing

All features tested manually:
- ✅ RSS fetching with retry
- ✅ Digest generation with LLM client
- ✅ Editorial reports with LLM client
- ✅ Metrics collection working
- ✅ Cost tracking accurate

## Next Steps

The observability infrastructure is now fully integrated. Recommended next steps:
1. Monitor metrics for 1-2 weeks
2. Adjust budgets and thresholds based on actual usage
3. Consider Phase 3: Testing and CI/CD (see optimization-todos.md)
```

### Step 7: Commit summary

```bash
git add docs/phase2-integration-complete.md
git commit -m "docs: add phase 2 integration completion summary

Document the successful integration of LLM client and retry utilities.
All pending tasks from Phase 2 are now complete.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Troubleshooting

### Issue: TypeScript errors after LLM client integration

**Symptom:** Build fails with type errors about LlmRequest or LlmResponse

**Solution:**
1. Check that LlmClient is properly exported in `llm/client.ts`
2. Verify the request format matches the LlmRequest type
3. Ensure provider is cast correctly: `config.llmProvider as "openai_compat"`

### Issue: LLM calls failing with "operation not allowed"

**Symptom:** LLM calls fail immediately

**Solution:**
1. Check that config has the required fields: `llmApiKey`, `llmModel`, `llmBaseUrl`
2. Verify the provider is set correctly in config
3. Check logs for detailed error messages

### Issue: Retry not working in RSS fetch

**Symptom:** RSS fetch fails immediately without retry

**Solution:**
1. Check that `shouldRetry` predicate matches the error type
2. Verify the error message contains expected patterns
3. Add logging to see what errors are being thrown

### Issue: Discord messages timing out

**Symptom:** Messages fail to send with timeout errors

**Solution:**
1. Increase timeout in AbortController if needed
2. Check Discord API status
3. Verify bot has proper permissions in the channel

### Issue: Metrics not showing up

**Symptom:** `/stats llm` shows no data

**Solution:**
1. Verify database tables exist (run migrations)
2. Check that metrics.ts is being imported correctly
3. Look for errors in logs when recording metrics
4. Verify observability tables in database: `docker-compose exec app npx prisma studio`

---

## Success Criteria

✅ **Phase 2 Integration Complete When:**

1. All 5 files successfully integrated (digest, editorial, deeper, rss, messaging)
2. All Discord commands work as before
3. LLM metrics appear in `/stats llm`
4. Cost tracking shows accurate data
5. No regressions in functionality
6. Logs show structured JSON format
7. Retry behavior works for transient failures
8. Documentation updated to reflect completion

---

## Related Documents

- `docs/plans/2026-01-14-observability-design.md` - Design specification
- `docs/plans/2026-01-14-observability-plan.md` - Infrastructure implementation
- `docs/phase2-summary.md` - Phase 2 summary
- `docs/optimization-todos.md` - Full optimization roadmap
- `DECISIONS.md` - Architectural decisions
