# DECISIONS.md - Job Listings Ingestion Pipeline

## What's Live

The live implementation ingests only Tier 1/2 sources:

- Tier 1 direct ATS APIs: Greenhouse boards configured in `src/sources.js`.
- Tier 2 open/public job-board APIs: RemoteOK, Arbeitnow, and Jobicy.

There is no LinkedIn, Naukri, Wellfound, or other hostile aggregator source in live configuration. There is also no disabled toggle, parser branch, seeded cache, or fetch path for those platforms. Tier 3 remains a design-only discussion below because the assignment asks for the strategy, but this repo deliberately avoids implementing it.

## Architecture

```text
[Scheduler / CLI / API trigger]
        |
        v
[Source router: src/sources.js]
        |
        +--> Tier 1 public ATS API
        |
        +--> Tier 2 public/open job API
        |
        v
[Fetcher: retry, jitter, honest User-Agent, polite rate limit]
        |
        v
[Parser: normalize, validate, schema drift detection]
        |
        v
[SQLite: jobs, runs, sources, raw_cache]
        |
        v
[Express API: /jobs, /runs, /health, /api/metrics]
```

## 1. Detection Surface

Modern anti-bot systems do not rely on a single obvious flag. They compare browser, network, hardware, and behavior signals and look for contradictions. A claimed Chrome-on-Windows User-Agent with non-browser TLS behavior or headless graphics fingerprints is more suspicious than any one field alone.

The live pipeline avoids this problem entirely by not pretending to be a browser and not using browser automation. `src/fetcher.js` sends an honest, identifiable `job-pipeline-demo/1.0` User-Agent to public JSON endpoints that are meant for integration.

## 2. Ingestion Strategy

The implementation follows a simple rule: do not scrape what is already syndicated.

Tier 1 direct ATS APIs are the preferred path because Greenhouse, Lever, Ashby, and similar systems expose structured public job-board APIs. Tier 2 public/open job-board APIs are acceptable when they are intended for programmatic consumption. The configured live sources are limited to those categories.

### Tier 3 Hostile Sources - Design Only

Tier 3 means aggregator-only pages where no public ATS or licensed feed exists. That strategy is not implemented in this repo. There is no source entry, no parser, no cache seed, and no code path that can be enabled to fetch LinkedIn, Naukri, Wellfound, or similar platforms.

If a future production system needed Tier 3 coverage, the correct first step would be a legal/product decision and a licensed/partner API search. Technical evasion would not be added as a demo feature, and no account, login wall, auth bypass, or ToS-prohibited automated access belongs in this repository.

## 3. Resilience

The current live resilience features are:

- Retry with exponential backoff and jitter in `src/fetcher.js`.
- Self-imposed per-domain rate limiting in `src/fetcher.js`.
- Last-known-good cache fallback in `src/fetcher.js` and `src/pipeline.js`, populated only after a real successful run.
- Parser-level schema drift escalation in `src/parser.js`.
- Content-hash deduplication in `src/parser.js` and `src/db.js`.
- Run telemetry in the `runs` table exposed through `/runs` and `/api/metrics`.

The cache starts empty. An empty cache should produce an honest no-data-yet state rather than fabricated prior listings.

## 4. Where We'd Stop

The legal and ethical boundary is public, logged-out, integration-friendly data only. The live implementation does not create accounts, bypass authentication, evade anti-bot systems, or resell scraped personal data.

The legal posture remains grounded in the distinction drawn by cases such as hiQ v. LinkedIn and Meta v. Bright Data: public, logged-out data is different from access behind authentication or from violating platform controls at scale. Practically, if a source is not intended for programmatic access, the next move is to find the licensed or partner API, not to hide automation.
