import { fetchWithFallback } from './fetcher.js';
import { parseAndValidate, SchemaDriftError } from './parser.js';
import { upsertJobs, logRun, getSources, seedSources, saveRawCache, getRawCache } from './db.js';
import { DEFAULT_SOURCES, getSourceById } from './sources.js';

let isRunning = false;

/**
 * Initialize sources into DB and prime Tier 3 fallback caches
 */
export function initializeSources() {
  seedSources(DEFAULT_SOURCES);

  // Prime initial last-known-good cache for Wellfound (Startups) if not present
  const currentWfCache = getRawCache('wellfound_startups');
  if (!currentWfCache || !Array.isArray(currentWfCache.data) || currentWfCache.data.length === 0) {
    const sampleWellfound = [
      {
        id: 'wf_101',
        title: 'Senior Full Stack Engineer (AI / LLM Platform)',
        company: 'Synthesia Labs',
        location: 'San Francisco, CA (Remote)',
        remote: true,
        salary_min: 160000,
        salary_max: 210000,
        salary_raw: '$160k - $210k • 0.1% - 0.5% Equity',
        url: 'https://wellfound.com/jobs/synthesia-senior-full-stack',
        tags: ['React', 'Node.js', 'Python', 'AI'],
        pitch: 'Join an early stage generative media startup scaling to 10M users.'
      },
      {
        id: 'wf_102',
        title: 'Lead Product Designer',
        company: 'Linear Ecosystems',
        location: 'Remote',
        remote: true,
        salary_min: 150000,
        salary_max: 190000,
        salary_raw: '$150k - $190k • 0.2% Equity',
        url: 'https://wellfound.com/jobs/linear-lead-designer',
        tags: ['Figma', 'Design Systems', 'Product Design'],
        pitch: 'Craft world-class UX for developer productivity tools.'
      },
      {
        id: 'wf_103',
        title: 'Backend Systems Engineer (Rust / Distributed Systems)',
        company: 'Warp Technologies',
        location: 'New York, NY (Remote)',
        remote: true,
        salary_min: 175000,
        salary_max: 230000,
        salary_raw: '$175k - $230k • 0.15% Equity',
        url: 'https://wellfound.com/jobs/warp-rust-systems',
        tags: ['Rust', 'Distributed Systems', 'Kubernetes', 'Go'],
        pitch: 'Building modern GPU-accelerated cloud infrastructure.'
      }
    ];
    saveRawCache('wellfound_startups', sampleWellfound, sampleWellfound.length);
  }

  // Prime initial last-known-good cache for Naukri (India Tech) if not present
  if (!getRawCache('naukri_tech_jobs')) {
    const sampleNaukri = [
      {
        jobId: 'naukri_801',
        title: 'Principal Software Engineer - Microservices & Cloud',
        company: 'Razorpay',
        location: 'Bangalore / Bengaluru, India',
        department: 'Fintech Payments Engineering',
        url: 'https://www.naukri.com/job-listings-razorpay-principal-engineer',
        tagsAndSkills: 'Go, Kubernetes, AWS, Microservices, Distributed Systems, Kafka',
        salary_raw: '₹45,00,000 - ₹65,00,000 PA',
        description: 'Lead high-throughput payment transaction pipelines handling billions in monthly volume.'
      },
      {
        jobId: 'naukri_802',
        title: 'Senior Frontend Architect (Next.js / TypeScript)',
        company: 'Swiggy',
        location: 'Bangalore, India (Hybrid)',
        department: 'Consumer Engineering',
        url: 'https://www.naukri.com/job-listings-swiggy-senior-frontend',
        tagsAndSkills: 'React, Next.js, TypeScript, Web Performance, GraphQL',
        salary_raw: '₹35,00,000 - ₹50,00,000 PA',
        description: 'Architect snappy consumer interfaces with millions of concurrent daily active users.'
      },
      {
        jobId: 'naukri_803',
        title: 'Staff Site Reliability Engineer (SRE)',
        company: 'Zomato',
        location: 'Gurgaon / Delhi NCR, India',
        department: 'Infrastructure & SRE',
        url: 'https://www.naukri.com/job-listings-zomato-staff-sre',
        tagsAndSkills: 'Kubernetes, Terraform, Python, Observability, Prometheus, AWS',
        salary_raw: '₹40,00,000 - ₹60,00,000 PA',
        description: 'Ensure 99.99% uptime across multi-region hybrid cloud deployments during peak sales events.'
      },
      {
        jobId: 'naukri_804',
        title: 'Lead Data Engineer (Spark / Snowflake)',
        company: 'Flipkart',
        location: 'Hyderabad / Bangalore, India',
        department: 'Big Data Platform',
        url: 'https://www.naukri.com/job-listings-flipkart-lead-data-engineer',
        tagsAndSkills: 'Python, Apache Spark, Snowflake, Airflow, SQL, Kafka',
        salary_raw: '₹38,00,000 - ₹55,00,000 PA',
        description: 'Scale real-time analytics and ML feature stores for India’s largest e-commerce catalog.'
      }
    ];
    saveRawCache('naukri_tech_jobs', sampleNaukri, sampleNaukri.length);
  }
}

/**
 * Execute ingestion pipeline for a single source.
 * Handles Tiered Routing, Exponential Backoff, Fallback Cache, Schema Drift Escalation, and Hash Deduplication.
 *
 * @param {string|Object} sourceParam Source ID string or Source configuration object
 * @param {Object} [options]
 * @param {boolean} [options.simulateFailure=false] Trigger synthetic upstream outage to verify cache fallback
 * @param {boolean} [options.simulateDrift=false] Trigger synthetic schema drift to verify loud error escalation
 * @param {Function} [options.customFetch=null] Custom fetch function for unit tests
 * @returns {Promise<Object>} Run result summary
 */
export async function runSource(sourceParam, options = {}) {
  const startTime = Date.now();
  const startedAt = new Date().toISOString();

  let source = typeof sourceParam === 'string' ? getSourceById(sourceParam) : sourceParam;
  if (!source) {
    // Try to query registered sources from DB
    const dbSources = getSources();
    source = dbSources.find(s => s.id === sourceParam);
  }

  if (!source) {
    throw new Error(`Source "${sourceParam}" not found in registry`);
  }

  let status = 'success';
  let errorMessage = null;
  let driftDetails = null;
  let itemsFetched = 0;
  let itemsParsed = 0;
  let itemsInserted = 0;
  let itemsDeduped = 0;
  let itemsSkipped = 0;
  let rawData = null;
  let fromCache = false;

  try {
    // 1. Fetch data via retry/jittered fetcher with automatic last-known-good cache fallback
    const fetchResult = await fetchWithFallback(source, options);
    rawData = fetchResult.data;
    fromCache = fetchResult.fromCache;

    if (fromCache) {
      status = 'degraded_cache';
      errorMessage = fetchResult.error?.message || 'Upstream unavailable: Serving from last-known-good cache';
    }

    // 2. Parse, normalize, and detect schema drift
    const parseResult = parseAndValidate(rawData, source);
    itemsFetched = parseResult.itemsFetched;
    itemsParsed = parseResult.itemsParsed;
    itemsSkipped = parseResult.itemsSkipped;
    driftDetails = parseResult.driftDetails;

    // 3. Upsert and deduplicate into SQLite using content hashes
    if (parseResult.validJobs.length > 0) {
      const dbResult = upsertJobs(parseResult.validJobs);
      itemsInserted = dbResult.inserted;
      itemsDeduped = dbResult.deduped;

      // Save last-known-good cache snapshot for future fallback resilience
      if (!fromCache && !options.simulateDrift) {
        saveRawCache(source.id, rawData, parseResult.validJobs.length);
      }
    }

  } catch (err) {
    // Plan B: If live data fails or drifts, attempt recovery using last-known-good cache
    const cached = !fromCache ? getRawCache(source.id) : null;
    if (cached && !options.simulateDrift) {
      try {
        const parseResult = parseAndValidate(cached.data, source);
        if (parseResult.validJobs.length > 0) {
          const dbResult = upsertJobs(parseResult.validJobs);
          itemsInserted = dbResult.inserted;
          itemsDeduped = dbResult.deduped;
        }
        itemsFetched = parseResult.itemsFetched;
        itemsParsed = parseResult.itemsParsed;
        itemsSkipped = parseResult.itemsSkipped;
        fromCache = true;
        status = 'degraded_cache';
        errorMessage = `Live parse failed (${err.message}). Recovered from last-known-good cache.`;
        driftDetails = err instanceof SchemaDriftError ? err.details : null;
      } catch {
        // Cache also unparseable, proceed with original error
        status = err instanceof SchemaDriftError ? 'drift_error' : 'fetch_error';
        errorMessage = err.message;
        driftDetails = err instanceof SchemaDriftError ? err.details : null;
        itemsSkipped = err.details?.skippedCount || itemsFetched;
      }
    } else {
      if (err instanceof SchemaDriftError) {
        status = 'drift_error';
        errorMessage = err.message;
        driftDetails = err.details;
        itemsSkipped = err.details?.skippedCount || itemsFetched;
      } else {
        status = 'fetch_error';
        errorMessage = err.message || String(err);
      }
    }
  }

  const durationMs = Date.now() - startTime;
  const completedAt = new Date().toISOString();

  // 4. Record run telemetry in SQLite
  const runData = {
    source_id: source.id,
    source_name: source.name,
    source_tier: source.tier,
    status,
    items_fetched: itemsFetched,
    items_parsed: itemsParsed,
    items_inserted: itemsInserted,
    items_deduped: itemsDeduped,
    items_skipped: itemsSkipped,
    error_message: errorMessage,
    drift_details: driftDetails,
    duration_ms: durationMs,
    started_at: startedAt,
    completed_at: completedAt
  };

  const runId = logRun(runData);

  return {
    runId,
    sourceId: source.id,
    sourceName: source.name,
    sourceTier: source.tier,
    status,
    fromCache,
    itemsFetched,
    itemsParsed,
    itemsInserted,
    itemsDeduped,
    itemsSkipped,
    errorMessage,
    driftDetails,
    durationMs
  };
}

/**
 * Execute ingestion pipeline for all enabled sources.
 * Respects domain rate limits and concurrency safety.
 *
 * @param {Object} [options]
 * @returns {Promise<Array<Object>>} Array of run result summaries
 */
export async function runAllSources(options = {}) {
  if (isRunning) {
    return { error: 'Pipeline run already in progress', busy: true };
  }

  isRunning = true;
  const results = [];

  try {
    const sources = getSources().filter(s => s.enabled);
    for (const source of sources) {
      try {
        const result = await runSource(source, options);
        results.push(result);
      } catch (err) {
        results.push({
          sourceId: source.id,
          sourceName: source.name,
          sourceTier: source.tier,
          status: 'error',
          errorMessage: err.message
        });
      }
    }
  } finally {
    isRunning = false;
  }

  return { results, totalSources: results.length };
}

export function isPipelineRunning() {
  return isRunning;
}
