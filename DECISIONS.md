# DECISIONS

Record of key architectural and process decisions. Update alongside `agent.md` and `docs/features.md` when scope or behavior changes.

## Documentation governance
Choice: maintain `agent.md`, directory READMEs with Change Logs, and `docs/features.md` as the canonical documentation system.
Alternatives: ad hoc doc updates without tracked change logs.
Why: consistent onboarding, traceable changes, and predictable workflows.

## Prompt management
Choice: store prompts under `prompts/` with one prompt per file and record prompt changes here.
Alternatives: embed prompts in code or track changes only in commit history.
Why: discoverability, reviewability, and explicit intent for prompt changes.

## Data model
Choice: Prisma with Postgres, models Source/Item/Digest.
Alternatives: SQLite, MongoDB.
Why: Postgres offers reliable concurrency, JSON/text fields, and easy Docker setup.

## RSS deduplication
Choice: contentHash = sha256(canonical_url + title + publishedAt).
Alternatives: hash of full content; GUID only.
Why: feed GUIDs are inconsistent; hash is stable and supports dedupe across minor URL variants.

## New source backfill cap
Choice: limit initial ingest for newly added sources to a small number of recent items (default 3).
Alternatives: ingest full back catalog or require manual trimming.
Why: avoids flooding channels with old posts when a source is first added.

## Backfill guard after initial ingest
Choice: for existing sources, stop processing feed items after hitting a streak of already-seen entries.
Alternatives: always scan the full feed and rely on dedupe only.
Why: prevents a second fetch from filling in the entire historical backlog after the initial cap.

## URL canonicalization
Choice: strip utm_* + ref/fbclid/gclid and normalize trailing slash.
Alternatives: full canonicalization library.
Why: keep logic simple while reducing common tracking params.

## Scheduling
Choice: node-cron in app container for fetch and digest.
Alternatives: external scheduler (cron/systemd) or separate worker container.
Why: single-container MVP reduces operational overhead.

## Digest strategy
Choice: default rule-based highlights; optional OpenAI-compatible LLM with fallback.
Alternatives: always LLM or no LLM support.
Why: ensures deterministic output without dependency on external provider.

## Digest delivery (thread mode)
Choice: post a single overview in the channel and item-by-item messages in a thread.
Alternatives: single large embed or multiple channel messages.
Why: avoids duplicate content in the main channel and keeps item details readable.

## Digest scheduler isolation
Choice: handle digest errors per channel and continue processing others.
Alternatives: abort the entire digest run on first failure.
Why: a misconfigured channel should not block digests for all channels.

## Source add channel restriction
Choice: allow `/source add` only in guild text or announcement channels.
Alternatives: allow threads/forums or any text-based channel.
Why: thread mode requires a text/news parent channel; preventing invalid channels avoids digest failures.

## Cron catch-up behavior
Choice: enable cron missed execution recovery for fetch/digest schedules.
Alternatives: only run on exact schedule times.
Why: when the app restarts after the scheduled time, missed digests should run on the next tick.

## LLM output format
Choice: LLM returns JSON with item summaries only.
Alternatives: freeform text parsing or adding trend extraction.
Why: JSON is more reliable to parse and map to item URLs; trends were removed to keep the digest focused.

## Digest overview formatting
Choice: render digest window in the configured TZ with a readable date/time format.
Alternatives: show UTC ISO timestamps.
Why: operators read digests in the local timezone and expect human-friendly time ranges.

## LLM output length control
Choice: expose LLM max tokens via env (LLM_MAX_TOKENS, default 2000).
Alternatives: hard-coded token limit.
Why: allows tuning response length to reduce truncation without code changes.

## LLM input content
Choice: use fetched full text only; for X/Twitter URLs, skip full-text fetch and fall back to RSS-provided content when available.
Alternatives: mix in RSS previews for all sources or use title-only summaries.
Why: full text gives the model enough context while avoiding shallow previews; X pages often block full-text fetch, so RSS content is a safer fallback.

## LLM response resilience
Choice: attempt best-effort JSON repair on minor truncation (escaped newlines/quotes and missing closing brackets).
Alternatives: hard-fail on any parse error.
Why: some providers return nearly valid JSON; repair improves coverage without changing the output contract.

## LLM summary fallback extraction
Choice: when JSON parsing fails, attempt to extract per-item summaries from partial output text.
Alternatives: drop LLM output entirely and fall back to local summaries.
Why: prevents wasted LLM output when responses are truncated mid-JSON.

## LLM skip for missing content
Choice: skip LLM summarization for items with insufficient content and show a fixed notice.
Alternatives: infer summaries from titles.
Why: avoids hallucinated summaries and makes missing content explicit.

## RSSHub failure detection
Choice: detect RSSHub error pages and surface failures in fetch and digest.
Alternatives: silently treat failures as no updates.
Why: avoids adding broken sources and makes dependency/config issues visible to operators.

## Prefer official RSS
Choice: recommend official RSS/Atom feeds first and only use RSSHub when no official feed is present.
Alternatives: always resolve via RSSHub.
Why: official feeds are more stable and avoid unnecessary dependencies.

## RSSHub as fallback adapter
Choice: expose `/source add others` to resolve non-RSS pages via RSSHub.
Alternatives: add per-platform integrations or scraping.
Why: provides broad coverage with minimal code while keeping RSS as the core ingestion format.

## Editorial item enrichment output
Choice: item-level writing suggestions must be strict JSON with a fixed schema.
Alternatives: freeform text or markdown sections.
Why: ensures reliable parsing and storage for downstream reporting.

## Editorial content insufficiency handling
Choice: when content is below `ENRICH_MIN_CONTENT_CHARS`, mark `content_insufficient=true` and emit a fixed notice without inference.
Alternatives: infer suggestions from title-only metadata.
Why: prevents hallucinated writing plans when sources lack summaries or full text.

## Editorial report output format
Choice: daily report uses a fixed 5-section markdown structure and `<url>` links to suppress previews.
Alternatives: variable formatting or markdown link syntax.
Why: consistent Discord rendering and predictable parsing for summaries.

## Editorial cost controls
Choice: cap enrichment and report item counts with `EDITORIAL_MAX_ITEMS`, `EDITORIAL_TWEET_COUNT`, and `EDITORIAL_BLOG_COUNT`.
Alternatives: process all items without limits.
Why: limit LLM spend and keep reports readable.

## Editorial enrichment toggle
Choice: add `EDITORIAL_ENRICH_ENABLED` to allow pausing item-level suggestions without deleting data or code.
Alternatives: remove enrichment logic entirely.
Why: keeps rollback simple while preserving the option to re-enable later.

## Deep dive prompt format
Choice: use a structured five-section Chinese summary prompt for 👀 deep dives and store the output in `Item.deepDive`.
Alternatives: freeform summaries or storing only ephemeral thread output.
Why: structured output is easier to scan and the stored summary enables reuse without rerunning the LLM.

## Deep dive content fallback and insufficiency tracking
Choice: for GitHub blob URLs, fetch raw markdown content before HTML parsing, and mark LLM "内容不足" responses with `deepDiveErrorReason=llm-insufficient`.
Alternatives: only parse HTML pages or treat LLM insufficiency as success without tracking.
Why: raw markdown improves coverage for GitHub docs, and explicit insufficiency markers aid diagnostics.

## Editorial discussion threads
Choice: when users post a forwarded message in the editorial channel, create a “创作讨论” thread and feed subsequent thread messages plus the original content into an LLM prompt.
Alternatives: manual prompt copy/paste or standalone commands.
Why: keeps writing tasks tied to source context and allows iterative refinement without re-copying.

## Editorial translation threads
Choice: when users post a direct URL or text in the editorial channel, create a translation thread and return a Chinese translation without summarization.
Alternatives: reuse discussion threads or manual translation.
Why: separates pure translation from writing tasks and keeps output in a dedicated thread.

## Observability infrastructure
Choice: use Pino for structured logging, Prisma for metrics storage, and Discord for observability UI.
Alternatives: external monitoring services (Prometheus/Grafana), log aggregation (ELK), or no observability.
Why: Pino is lightweight and fast; storing metrics in Postgres reuses existing infrastructure; Discord integration provides instant visibility without additional services.

## Metrics collection strategy
Choice: automatically record metrics for all critical operations (LLM calls, RSS fetches, digest/editorial runs) with type, status, and metadata.
Alternatives: manual logging only, sampling, or external APM tools.
Why: comprehensive metrics enable cost tracking, failure analysis, and performance monitoring without external dependencies.

## Alert rules and notification
Choice: periodic rule checks (hourly) with Discord notifications for critical issues (LLM failures, cost overruns, storage warnings).
Alternatives: real-time alerting, webhook integrations, or email notifications.
Why: hourly checks balance responsiveness with resource usage; Discord keeps alerts in the same platform as other bot interactions.

## LLM client abstraction
Choice: unified LLM client with automatic retry, fallback, token counting, and cost tracking.
Alternatives: per-feature LLM implementations, external LLM proxy services, or no abstraction.
Why: centralized client ensures consistent error handling, reduces code duplication, and simplifies future LLM provider changes.

## Retry strategy
Choice: exponential backoff with configurable max attempts and retryable error predicates.
Alternatives: fixed delay, jittered backoff, or no retry.
Why: exponential backoff reduces load during outages; custom error predicates allow fine-grained control over retry behavior.

## Data archival approach
Choice: soft delete with `archivedAt` timestamp rather than hard delete or separate archive table.
Alternatives: hard delete old data, move to archive table, or never delete.
Why: soft delete preserves all data for analysis while improving query performance; single table simplifies queries; can migrate to separate table later if needed.

## Metrics retention policy
Choice: retain observability metrics for 90 days, alerts for 30 days (resolved only).
Alternatives: indefinite retention, shorter periods, or tiered storage.
Why: 90 days covers most troubleshooting scenarios; automatic cleanup prevents unbounded growth; configurable retention allows tuning.

## Discord observability channel
Choice: dedicated channel for stats commands, alerts, and daily reports.
Alternatives: DMs, embed alerts in existing channels, or separate monitoring dashboard.
Why: centralized observability keeps monitoring visible and accessible; Discord-native UI leverages existing infrastructure; commands provide on-demand insights.
