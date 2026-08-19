# IngestFlow — Job Listings Ingestion Pipeline

A production-grade, resilient **Job Listings Ingestion Pipeline** built with Node.js, Express, SQLite, and Vanilla ES modules. Designed around the architectural and compliance principles specified in [DECISIONS.md](file:///d:/Project/AYCDOn/DECISIONS.md).

---

## 🏛️ Architecture

```
[Scheduler / Manual Trigger / CLI]
               │
               ▼
[Source Router] ──Tier 1: Direct ATS API───▶ [Greenhouse / Lever / Ashby] (JSON, no auth)
     │                                                │
     ├──Tier 2: Licensed / Open Feeds─▶ [RemoteOK / Arbeitnow / Jobicy]
     │                                                │
     └──Tier 3: Aggregator / Evasion Simulation─▶ [Paced fetch + Human-like jitter]
                                                       │
                                                       ▼
                              [Fetcher: 3x Retry + Exp Backoff + Jitter + Token Bucket Pacing]
                                                       │ on failure
                                                       ▼
                                              [Fallback: Last-Good SQLite Cache]
                                                       │
                                                       ▼
                                  [Parser: Canonical Normalizer + Validator]
                                                       │
                                        ┌──────────────┴──────────────┐
                                        ▼                             ▼
                            [Schema Drift Detection]          [Content Hashing]
                                        │ (Loud error if 100% drift)  │ (SHA-256 deduplication)
                                        ▼                             ▼
                                   [Storage: SQLite (Jobs, Runs, Sources, Cache)]
                                                       │
                                                       ▼
                               [Express REST API (/jobs, /runs, /health, /metrics)]
                                                       │
                                                       ▼
                               [Modern Dark-Mode Interactive Web Dashboard UI]
```

---

## 🚀 Key Features

### 1. Tiered Sourcing Strategy
- **Tier 1 (Direct ATS APIs):** Greenhouse (e.g. Figma, Cloudflare, Stripe, Discord), Lever, and Ashby. Ingests directly from open corporate endpoints without auth, zero ban risk, and complete structured salary/location/team fields.
- **Tier 2 (Open / Licensed Feeds):** Integration-friendly feeds (RemoteOK, Arbeitnow, Jobicy) with self-imposed rate limits.
- **Tier 3 (Aggregators & Evasion-Grade Fallbacks):**
  - **LinkedIn (Public Guest Jobs):** Ingests live unauthenticated listings from LinkedIn's public guest endpoint with zero auth bypass, strictly adhering to the *hiQ v. LinkedIn* public data doctrine.
  - **Wellfound (AngelList Startups):** Ingests startup tech roles with equity and compensation breakdowns.
  - **Naukri (India Tech Ecosystem):** Demonstrates Tier 3 anti-bot recovery by automatically activating the last-known-good cache fallback when upstream WAF blocks raw requests.

### 2. High Resilience & Failure Recovery
- **Exponential Backoff with Full Randomized Jitter:** Retries transient 429 and 5xx errors up to 3 times before failing.
- **Polite Domain-Level Rate Limiting:** Enforces minimum request intervals per hostname.
- **Last-Known-Good SQLite Cache Fallback:** If an upstream source fails or suffers network outage, the pipeline automatically falls back to the latest valid raw snapshot and flags the run as `degraded_cache`.
- **Loud Schema Drift Escalation:** Compares incoming payload structures against canonical schemas. If batch-level validation failure exceeds threshold (>80% or 100% on non-empty response), the pipeline throws a loud `SchemaDriftError`, halts the transaction, logs drift alerts, and avoids poisoning the database.
- **Deterministic Deduplication via Content Hash:** Generates a SHA-256 fingerprint over normalized `[company, title, location, description_excerpt]` to deduplicate syndicated postings across different job boards and external IDs.

---

## 📡 REST API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` or `/api/health` | Pipeline health, database size, active jobs, last run status |
| `GET` | `/jobs` or `/api/jobs` | Searchable, multifaceted job listings query engine (`search`, `tier`, `isRemote`, `sortBy`, `page`, `limit`) |
| `GET` | `/jobs/:id` or `/api/jobs/:id` | Single job details and canonical normalized schema |
| `GET` | `/runs` or `/api/runs` | Ingestion run history, telemetry, deduplication metrics, and error diagnostics |
| `GET` | `/api/sources` | Registered sources across Tier 1, 2, and 3 |
| `GET` | `/api/metrics` | Pipeline telemetry (total jobs, dedup rate %, tier breakdown) |
| `POST` | `/api/pipeline/trigger` | Trigger manual ingestion run or test simulation (`simulateFailure`, `simulateDrift`) |

---

## 💻 Quick Start & Commands

### Prerequisites
- Node.js >= v22 (v24 recommended for native `node:sqlite` and test runner)

### Installation
```powershell
npm install
```

### Run Automated Tests (100% Pass)
```powershell
npm test
```

### Start API Server & Web Dashboard
```powershell
npm start
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser to access the interactive dark-mode dashboard.

### Run CLI Ingestion Directly
```powershell
# Ingest all enabled sources
npm run ingest

# Or ingest a specific source
node src/cli.js greenhouse_figma
```

---

## 🧪 Testing Scenarios

The suite includes 13 unit and integration tests covering:
1. **Fetcher:** Retry backoff, randomized jitter bounds, timeout handling, retryable 500 status codes.
2. **Parser:** Deterministic SHA-256 deduplication hashing, Greenhouse/Lever normalization, skipping individual malformed records, and batch-level Schema Drift loud escalation.
3. **Pipeline:** Deduplication idempotency, SQLite insertion vs refresh, and last-known-good cache fallback recovery during simulated outages.
4. **API:** Health checks, paginated job searches, runs audit logging, and metrics aggregation.

---

## ⚖️ Legal & Compliance Posture
Refer to [DECISIONS.md](file:///d:/Project/AYCDOn/DECISIONS.md) for the legal framework grounded in *hiQ v. LinkedIn* (9th Cir.) and *Meta v. Bright Data* (2024), enforcing:
- Public, logged-out data only.
- Zero authentication bypass.
- No commercial resale of scraped personal data.
