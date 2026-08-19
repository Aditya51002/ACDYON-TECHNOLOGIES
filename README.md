# IngestFlow - Job Listings Ingestion Pipeline

A Node.js, Express, SQLite, and Zod ingestion pipeline for public ATS and open job-board APIs. The live demo intentionally avoids hostile aggregators and browser automation.

## Architecture

```text
[Scheduler / Manual Trigger / CLI]
        |
        v
[Source Router]
        +--> Tier 1 direct ATS APIs: Greenhouse, Lever, Ashby-compatible parsers
        +--> Tier 2 open/public feeds: RemoteOK, Arbeitnow, Jobicy
        |
        v
[Fetcher: retry, jitter, honest User-Agent, polite rate limit, circuit breaker]
        |
        v
[Bronze: raw_fetches append-only payload audit]
        |
        v
[Parser: canonical normalization, Zod validation, schema drift checks]
        |
        v
[Silver: jobs with hashes, staleness, completeness, salary normalization]
        |
        v
[Gold: reporting views, metrics, dashboard]
```

## Compliance Posture

Only Tier 1/2 sources are live. LinkedIn, Naukri, Wellfound, and similar hostile aggregator sources are discussed only in [DECISIONS.md](./DECISIONS.md) as design-only boundaries. There is no live source entry, parser branch, seeded fallback data, disabled toggle, or browser automation path for those platforms.

## Features

- Public ATS and open job-board source registry.
- Bronze/Silver/Gold SQLite storage with raw payload audit views.
- `run_id` idempotency for raw fetches, runs, and job writes.
- Zod-backed canonical job contract with `SCHEMA_VERSION`.
- Exponential backoff, jitter, per-domain rate limiting, cache fallback, and circuit breaker.
- Incremental fetch watermarks, stale listing marking, and last-seen tracking.
- Exact hash deduplication plus fuzzy merge/review banding.
- Dead-letter queue for malformed records and schema drift failures.
- Completeness scoring, UTC date normalization, and USD salary normalization.
- Express API, `/metrics` observability, and browser dashboard.

## API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` or `/api/health` | Pipeline health and database summary |
| `GET` | `/jobs` or `/api/jobs` | Searchable active non-stale listings with `X-Schema-Version` |
| `GET` | `/jobs/:id` or `/api/jobs/:id` | Single job detail |
| `GET` | `/runs` or `/api/runs` | Ingestion run history |
| `GET` | `/api/sources` | Configured live sources |
| `GET` | `/metrics` or `/api/metrics` | Pipeline metrics and source observability |
| `POST` | `/api/pipeline/trigger` | Trigger all sources or one source |

## Commands

```powershell
npm install
npm test
npm start
```

The server reads `PORT` from the environment and defaults to `3000`.
