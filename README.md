# IngestFlow - Job Listings Ingestion Pipeline

A Node.js, Express, and SQLite job listings ingestion pipeline for public ATS and open job-board APIs. The live demo intentionally avoids hostile aggregators and browser automation.

## Architecture

```text
[Scheduler / Manual Trigger / CLI]
        |
        v
[Source Router]
        +--> Tier 1 direct ATS APIs: Greenhouse, Lever, Ashby-compatible parser support
        +--> Tier 2 open/public feeds: RemoteOK, Arbeitnow, Jobicy
        |
        v
[Fetcher: retry, jitter, honest User-Agent, polite rate limit]
        |
        v
[Parser: canonical normalization, validation, schema drift checks]
        |
        v
[SQLite: jobs, runs, sources, last-known-good cache]
        |
        v
[Express REST API and dashboard]
```

## Compliance Posture

Only Tier 1/2 sources are live. LinkedIn, Naukri, Wellfound, and similar hostile aggregator sources are discussed only in [DECISIONS.md](./DECISIONS.md) as design-only boundaries. There is no live source entry, parser branch, seeded fallback data, or disabled toggle for those platforms.

## Features

- Public ATS and open job-board source registry.
- Exponential backoff with jitter and per-domain rate limiting.
- Honest identifiable User-Agent for public API requests.
- Last-known-good cache populated only by real successful runs.
- SQLite-backed jobs, sources, and run telemetry.
- Content-hash deduplication.
- Express API and browser dashboard.

## API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` or `/api/health` | Pipeline health and database summary |
| `GET` | `/jobs` or `/api/jobs` | Searchable job listings |
| `GET` | `/jobs/:id` or `/api/jobs/:id` | Single job detail |
| `GET` | `/runs` or `/api/runs` | Ingestion run history |
| `GET` | `/api/sources` | Configured live sources |
| `GET` | `/api/metrics` | Pipeline summary metrics |
| `POST` | `/api/pipeline/trigger` | Trigger all sources or one source |

## Commands

```powershell
npm install
npm test
npm start
```

The server reads `PORT` from the environment and defaults to `3000`.
