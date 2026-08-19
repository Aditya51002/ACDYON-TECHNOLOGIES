# DECISIONS.md — Job Listings Ingestion Pipeline

## What's live

The deployed demo pulls listings from a public, integration-friendly job board API (no auth, explicitly built for programmatic access), normalizes them into a consistent schema, dedupes by content hash, and serves them via a small Express API (`/jobs`, `/runs`, `/health`). This is deliberately the "safe source" the brief asks for — the sections below are the design answer for how the same pipeline would need to change to handle a hostile source like LinkedIn, Indeed, or Naukri, and why the live demo doesn't attempt that against a real account.

## Architecture

```
[Scheduler]
     │
     ▼
[Source Router] ──Tier 1: known company──▶ [ATS JSON API]  (Greenhouse/Lever/Ashby/Workday — no auth)
     │                                            │
     ├──Tier 2: no ATS, open source─────▶ [Licensed/public API or RSS]  (live demo's source)
     │                                            │
     └──Tier 3: aggregator-only, last resort──▶ [Evasion-grade fetch]  (design-only, not in live demo)
                                                   │
                                                   ▼
                          [Fetcher: retry+backoff, self-imposed rate limit]
                                                   │ on failure
                                                   ▼
                                          [Fallback: last-good cache]
                                                   │
                                                   ▼
                              [Parser: normalize+validate+schema-drift check]
                                                   │ on total drift
                                                   ▼
                                         [Hard error, not silent]
                                                   │
                                                   ▼
                                    [Storage: SQLite, dedup] → [API]
```

Each stage fails independently and visibly — a schema change breaks the parser, not the fetcher; a dead source triggers fallback, not a crash. The Source Router is the actual strategic layer: it means most volume never touches an evasion path at all, and the hard scraping problem the brief describes is scoped down to the minority of listings that genuinely have no structured origin.

---

## 1. Detection surface

Naive automation gets caught on the obvious stuff — a raw `navigator.webdriver` flag, a `HeadlessChrome` UA string, missing `Accept-Language` headers. That layer was "solved" (from the evader's side) years ago by stealth plugins, so it's not where real anti-bot systems spend their budget anymore. What actually catches automation in 2026:

- **Cross-signal consistency, not single signals.** A UA claiming Chrome on Windows while WebGL reports a headless renderer, or where the TLS fingerprint doesn't match the claimed browser/OS combination, is a contradiction no real browser produces — and that mismatch, not any one signal, is what fires the detector.
- **Hardware-level fingerprints.** WebGL renderer strings are the strongest single JS-level signal available: a headless browser in a cloud VM reports a virtual GPU (SwiftShader/llvmpipe) that's trivially distinguishable from real consumer hardware, and it's expensive to spoof convincingly at scale.
- **Network-layer fingerprints (TLS/JA4).** These require patching the transport stack, not JavaScript — most off-the-shelf automation doesn't touch this layer at all, which is why it's a durable tell.
- **Behavioral biometrics.** Real cursor movement has micro-corrections and acceleration/deceleration that scripted `mouse.move(x, y)` calls don't reproduce; modern platforms score this against models trained on real human sessions.
- **Adaptive, not static, blocking.** Enterprise anti-bot platforms (Cloudflare, Akamai, DataDome, HUMAN/PerimeterX, Kasada) adjust thresholds based on request patterns over time — a pattern that worked last month can start failing gradually, not all at once, which means "it's not blocked yet" isn't evidence it's undetectable.

What this design accounts for, at the level appropriate for the live demo: the fetcher already treats every request as something that should look self-imposed-polite (rate-limited, backed off, jittered) rather than maximally fast — the same posture that would need to extend to identity/session management for a harder source, described below.

## 2. Ingestion strategy

For the safe source in the live demo: a single fetcher with retry (exponential backoff + jitter, 3 attempts) and a self-imposed rate limit, regardless of whether the source enforces one.

### The core strategic decision: don't scrape what's already syndicated

Before designing any evasion layer, the actual bottleneck question is: does this job posting already exist somewhere that *wants* to be read? The five biggest applicant tracking systems — Workday, Greenhouse, Lever, Ashby, and SmartRecruiters — all publish public, no-authentication JSON APIs for their own job boards, because companies want these postings syndicated; that's the entire point of the API existing. Greenhouse's public Boards API alone covers job boards for 220,000+ companies and returns structured JSON over plain HTTP — no browser, no proxy, no session management, nothing to detect.

This changes the architecture from "one hard scraping problem" into a **tiered sourcing strategy**:

1. **Tier 1 — Direct ATS APIs.** Route known company career pages to their underlying Greenhouse/Lever/Ashby/Workday endpoint instead of parsing the rendered page. Fastest, cheapest, zero ban risk, and the data is more complete (structured salary/location/department fields) than what most listing pages render visually. The one real cost: there's no master directory of which companies use which ATS — board tokens have to be discovered once (crawling careers pages) and cached, not rediscovered per run.
2. **Tier 2 — Licensed/partner feeds.** RSS or public job-board APIs (the live demo's approach) for sources built for open integration.
3. **Tier 3 — Evasion-grade scraping, as a last resort only.** Reserved for aggregator-only listings (e.g. a role posted solely on an aggregator with no upstream ATS) where no structured path exists at all. This is where the hostile-source design below applies — and it should be a small minority of total volume in a well-designed pipeline, not the default path.

### For the Tier 3 fallback (design-only, not implemented against a live account)

Two competing philosophies, and the right one depends on what the business actually needs:

- **API-first, scraping as last resort** (restated at the individual-source level): even within Tier 3, prefer any partial official access — an RSS feed, a public search endpoint — over full page automation wherever one exists.
- **Distributed, human-paced ingestion**, only where scraping is genuinely the only option. The identity/session layer matters more than raw IP volume:
  - **Segment by workflow, not by default.** Stateless collection (a single public listing page, no login) uses per-request IP rotation. Anything involving cookies, session continuity, or a multi-step flow uses a sticky session — rotating mid-flow breaks continuity and is itself a stronger tell than staying put.
  - **Consistency across signals matters more than rotation frequency.** Perfectly regular request timing across many IPs is a bot signal even when the IP keeps changing — timing needs jitter, not just address. A session's apparent geography also needs to stay consistent; an IP that jumps countries mid-session trips fraud checks independent of anything scraping-specific.
  - **Treat each identity as a rate-limited budget**, not an infinite resource — cap requests per identity before rotating out, rather than rotating reactively only after a block.

Plan B when the primary approach gets shut down in a week: the pipeline degrades to serving last-known-good cached data (already implemented) while alerting, rather than going empty or crashing — buys time to diagnose without the consumer-facing surface breaking. Because Tier 1/2 sources carry most of the volume in this design, a Tier 3 source going dark degrades completeness, not availability.

## 3. Resilience

There's a useful distinction between tiers of "resilience" that's worth being explicit about instead of hand-waving:

1. **Retry/circuit-breaking** — handles transient network failures. This is baseline hygiene, not a differentiator. Implemented in `fetcher.js`.
2. **Schema-drift detection** — compares incoming data against an expected shape (field presence, types, record volume within a normal range) and flags or reroutes when reality diverges from baseline, instead of silently parsing garbage into the database. Implemented in `parser.js`: individual malformed items are skipped and counted; if *every* item in a batch fails validation, that's escalated as a hard error rather than treated as noise.
3. **Self-healing** (not implemented here, noted as the natural next step, but worth designing correctly rather than hand-waving) — automatically proposing and validating selector/schema fixes when drift is detected. The industry pattern worth citing: in field reports, a baseline scraper with only retry logic runs around a 64% success rate and 71% completeness against hostile sources; adding a full self-healing loop (fetch → detect → propose fix → validate → promote) pushes that to roughly 92% success and 96% completeness, at the cost of being measurably slower per page. The tradeoff is favorable specifically because the cost of *missing* data is usually higher than a few extra seconds of runtime.
   - The trap to design around: an LLM-proposed selector fix can be syntactically valid but semantically wrong. No proposed fix should reach production without an independent deterministic check — comparing extracted values against the previous known-good sample, verifying key fields (e.g. job title, company) actually appear as a substring of the source text rather than being invented, and gating anything below a confidence threshold to human review instead of auto-promoting it.
   - This also means schema-drift detection and self-healing shouldn't be conflated: a shape change that looks recoverable might actually be a semantic change (e.g. a "salary" field silently repurposed), and blind auto-patching would hide that regression instead of surfacing it.

The through-line: nothing in this pipeline fails silently. A dead source falls back to cache and logs a run record; a malformed response is caught by parser validation; a real schema change is loud, not quiet.

## 4. Where we'd stop

This is grounded in actual case law rather than a general "we follow ToS" gesture, because the legal reality here is more specific than that:

- **Public, logged-out data only.** The 9th Circuit's *hiQ v. LinkedIn* ruling held the CFAA's "without authorization" clause doesn't reach scraping of public profile data — and that holding survived LinkedIn's later settlement with hiQ. Separately, *Meta v. Bright Data* (Jan 2024) reinforced that logged-out scraping of public pages is the most legally defensible posture available in 2026.
- **No authentication bypass, ever.** The part of the hiQ case that *did* go against hiQ was its use of fake accounts and contractors to access data behind LinkedIn's login wall — that's the line between "scraping public data" and "unauthorized access," and it's a bright one.
- **No commercial resale of scraped personal data.** LinkedIn has continued suing scraping-as-a-service businesses on this exact ground into 2026; ToS violations don't create criminal CFAA liability post-hiQ, but they absolutely create breach-of-contract exposure, and that risk concentrates hardest around resale.
- **Technical line matches the legal one.** The pipeline design above only extends its "harder" ingestion strategy to logged-out, publicly rendered pages — it does not create accounts, does not touch anything behind auth, and the live demo deliberately runs against a source built for open integration rather than against a platform whose ToS prohibits this.

Practically: if a source's data isn't reachable without logging in, or isn't intended for programmatic use, the answer is "find the licensed/partner API," not "get better at hiding."
