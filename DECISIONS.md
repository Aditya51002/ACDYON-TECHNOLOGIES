# DECISIONS.md - Job Listings Ingestion Pipeline

## Detection Surface

Modern anti-bot systems do not rely on one obvious signal. They correlate browser claims, TLS/network signatures, rendering behavior, request cadence, hardware fingerprints, and user interaction patterns. A client that claims to be Chrome on Windows while sending non-browser transport fingerprints, headless rendering hints, or perfectly regular timing is detectable because the signals disagree.

The live implementation avoids that problem entirely. It does not use browser automation, does not impersonate consumer browsers, and does not try to hide scripted access. `src/fetcher.js` sends an honest `job-pipeline-demo/1.0` User-Agent to public JSON endpoints that are intended for integration or syndication.

## Ingestion Strategy

The source router follows a conservative rule: do not scrape what is already syndicated.

`src/sources.js` registers only Tier 1 and Tier 2 live sources:

- Tier 1: direct ATS/public boards such as Greenhouse. Parser support also covers Lever and Ashby-style public board payloads in `src/parser.js`.
- Tier 2: open/public job feeds such as RemoteOK, Arbeitnow, and Jobicy.

`src/pipeline.js` orchestrates the implemented flow:

```text
trigger or scheduler
  -> source router
  -> fetchWithFallback
  -> raw_fetches Bronze append-only storage
  -> parser + Zod contract validation
  -> jobs Silver upsert and entity resolution
  -> Gold SQLite views and API metrics
```

Incremental fetching is implemented with `supports_updated_at`, `sources.last_seen_at`, `posted_at`, and `last_seen_hash`. A source that supports deltas can skip records at or before the last successful watermark while still storing the raw response for audit. Staleness is handled after successful live fetches by `markMissingJobsStale`, which increments `missing_count` and marks listings stale only after repeated absence.

Circuit breaking is implemented in `src/db.js` and enforced in `src/pipeline.js` through `sources.consecutive_failures`, `circuit_open_until`, and `circuit_trip_count`. Repeated fetch or drift failures open the circuit, and later runs are logged as `skipped_circuit` instead of repeatedly hammering an unhealthy upstream.

### Tier 3 Hostile Sources - Design Only

Tier 3 means aggregator-only pages where no public ATS, partner, or licensed feed exists. That strategy is intentionally not implemented in this repository.

There is no source entry, no parser, no cache seed, no disabled toggle, and no code path that can be enabled to fetch LinkedIn, Naukri, Wellfound, or similar hostile aggregators. If future product requirements needed coverage from that class of site, the next step would be a legal/product review and a licensed or partner data path, not browser evasion.

## Resilience & Data Quality

The pipeline uses Bronze/Silver/Gold storage boundaries:

- Bronze: `raw_fetches` stores raw upstream payloads append-only with `(source_id, run_id)` idempotency. `saveRawFetch` preserves the received payload for replay and audit.
- Silver: `jobs` stores canonical normalized listings with exact hashes, source record keys, salary normalization fields, completeness scores, stale flags, and schema version.
- Gold: `jobs_by_company_daily`, `high_completeness_jobs`, and `run_log` are SQLite views for API and reporting use.

Idempotency is centered on `run_id`. `runs.id` is unique, `raw_fetches` is unique by `(source_id, run_id)`, and `runSource` returns a replay summary if a completed run is retried with the same id. Silver writes also carry `first_seen_run_id`, `last_seen_run_id`, and `run_id` for auditability.

Data contracts live in `src/schema.js`. The canonical job schema is validated with Zod and versioned by `SCHEMA_VERSION`. Extra optional upstream fields are treated as safe schema evolution and recorded in drift details; missing required canonical fields or mass validation failure raises `SchemaDriftError` in `src/parser.js`.

Bad records go to a dead-letter queue instead of disappearing. `failed_records` stores the source, run, raw item, error details, stage, and schema version. `saveFailedRecords` is called for parser-level failures and drift failures so malformed input remains inspectable.

Entity resolution uses three bands in `src/db.js`:

- Exact duplicate: stable `content_hash` or `source_record_key` updates last-seen metadata without inserting another job.
- High-confidence fuzzy match: same company/city block plus score `>= 0.90` auto-merges.
- Middle band: score `>= 0.70` and `< 0.90` inserts the record but queues `dedup_review` for human review.

Observability is exposed through `/metrics` and `/api/metrics`. `getPipelineMetrics` and `getSourceObservability` report freshness, run volume, status distribution, schema drift count, stale count, source distribution, cache fallbacks, and average daily volume. `/jobs` responses include `X-Schema-Version`, and clients can filter by `minCompleteness`.

Completeness scoring, UTC date normalization, and USD salary normalization are computed during canonicalization in `src/schema.js` and `src/parser.js`. Every parser stores `posted_at` and `ingested_at` as UTC ISO timestamps, and salary fields retain raw values while adding normalized annual USD estimates where enough information exists.

## Where We'd Stop

The operational boundary is public, logged-out, integration-friendly data. The live system does not create accounts, bypass authentication, evade access controls, defeat CAPTCHAs, or resell scraped personal data.

The design posture is grounded in the public-data distinction discussed in cases such as hiQ Labs v. LinkedIn and Meta v. Bright Data: public unauthenticated access is a different risk category from bypassing login walls, platform controls, or contractual restrictions. This repository treats that distinction as a floor, not a permission slip. If a source is not intended for programmatic access, the correct engineering answer is to find the licensed/partner API or decline the source.
