import { fetchWithFallback } from './fetcher.js';
import { parseAndValidate, SchemaDriftError } from './parser.js';
import { upsertJobs, logRun, getSources, seedSources, saveRawCache, getRawCache } from './db.js';
import { DEFAULT_SOURCES, getSourceById } from './sources.js';

let isRunning = false;

/**
 * Initialize configured Tier 1/2 sources into DB.
 */
export function initializeSources() {
  seedSources(DEFAULT_SOURCES);
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
