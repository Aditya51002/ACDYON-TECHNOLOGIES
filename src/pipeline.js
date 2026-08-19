import crypto from 'node:crypto';
import { fetchWithFallback } from './fetcher.js';
import { parseAndValidate, SchemaDriftError } from './parser.js';
import {
  upsertJobs,
  logRun,
  getRunById,
  getSources,
  getSourceRuntimeState,
  isCircuitOpen,
  seedSources,
  saveRawCache,
  getRawCache,
  saveRawFetch,
  saveFailedRecords,
  markMissingJobsStale,
  recordSourceSuccess,
  recordSourceFailure
} from './db.js';
import { DEFAULT_SOURCES, getSourceById } from './sources.js';

let isRunning = false;

/**
 * Initialize configured Tier 1/2 sources into DB.
 */
export function initializeSources() {
  seedSources(DEFAULT_SOURCES);
}

function runSummaryFromRow(row) {
  return {
    runId: row.id,
    sourceId: row.source_id,
    sourceName: row.source_name,
    sourceTier: row.source_tier,
    status: row.status,
    fromCache: Boolean(row.from_cache),
    itemsFetched: row.items_fetched,
    itemsParsed: row.items_parsed,
    itemsInserted: row.items_inserted,
    itemsDeduped: row.items_deduped,
    itemsUpdated: row.items_updated,
    itemsUnchanged: row.items_unchanged,
    itemsSkipped: row.items_skipped,
    itemsStale: row.items_stale,
    reviewQueued: row.review_queued,
    errorMessage: row.error_message,
    driftDetails: row.drift_details,
    durationMs: row.duration_ms,
    replayed: true
  };
}

function maxPostedAt(jobs, fallback) {
  if (jobs.length === 0) return fallback;
  let max = 0;
  for (const job of jobs) {
    const time = new Date(job.posted_at).getTime();
    if (!Number.isNaN(time) && time > max) max = time;
  }
  return max > 0 ? new Date(max).toISOString() : fallback;
}

function filterIncrementalJobs(jobs, source, { disableIncremental = false } = {}) {
  if (disableIncremental || !source.supports_updated_at || !source.last_seen_at) {
    return jobs;
  }

  const cursorTime = new Date(source.last_seen_at).getTime();
  if (Number.isNaN(cursorTime)) return jobs;
  return jobs.filter(job => new Date(job.posted_at).getTime() > cursorTime);
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
  const runId = options.runId || `run_${crypto.randomUUID?.() || `${Date.now()}_${Math.random()}`}`;

  const existingRun = options.runId ? getRunById(options.runId) : null;
  if (existingRun && ['success', 'degraded_cache', 'fetch_error', 'drift_error', 'skipped_circuit'].includes(existingRun.status)) {
    return runSummaryFromRow(existingRun);
  }

  let source = typeof sourceParam === 'string' ? getSourceById(sourceParam) : sourceParam;
  if (!source) {
    // Try to query registered sources from DB
    const dbSources = getSources();
    source = dbSources.find(s => s.id === sourceParam);
  }

  if (!source) {
    throw new Error(`Source "${sourceParam}" not found in registry`);
  }

  const storedSource = getSourceRuntimeState(source.id);
  if (storedSource) {
    source = {
      ...source,
      ...storedSource,
      enabled: Boolean(storedSource.enabled),
      supports_updated_at: Boolean(storedSource.supports_updated_at)
    };
  }

  const circuit = isCircuitOpen(source.id);
  if (circuit.open && !options.ignoreCircuitBreaker) {
    const completedAt = new Date().toISOString();
    const skippedRunId = logRun({
      id: runId,
      source_id: source.id,
      source_name: source.name,
      source_tier: source.tier,
      status: 'skipped_circuit',
      items_fetched: 0,
      items_parsed: 0,
      items_inserted: 0,
      items_deduped: 0,
      items_updated: 0,
      items_unchanged: 0,
      items_skipped: 0,
      items_stale: 0,
      review_queued: 0,
      error_message: `Circuit open until ${circuit.openUntil}`,
      drift_details: null,
      duration_ms: Date.now() - startTime,
      started_at: startedAt,
      completed_at: completedAt
    });

    return {
      runId: skippedRunId,
      sourceId: source.id,
      sourceName: source.name,
      sourceTier: source.tier,
      status: 'skipped_circuit',
      fromCache: false,
      itemsFetched: 0,
      itemsParsed: 0,
      itemsInserted: 0,
      itemsDeduped: 0,
      itemsUpdated: 0,
      itemsUnchanged: 0,
      itemsSkipped: 0,
      itemsStale: 0,
      reviewQueued: 0,
      errorMessage: `Circuit open until ${circuit.openUntil}`,
      driftDetails: null,
      durationMs: Date.now() - startTime
    };
  }

  let status = 'success';
  let errorMessage = null;
  let driftDetails = null;
  let itemsFetched = 0;
  let itemsParsed = 0;
  let itemsInserted = 0;
  let itemsDeduped = 0;
  let itemsUpdated = 0;
  let itemsUnchanged = 0;
  let itemsSkipped = 0;
  let itemsStale = 0;
  let reviewQueued = 0;
  let rawData = null;
  let fromCache = false;
  let rawFetch = null;
  let parsedJobsForCursor = [];

  try {
    // 1. Fetch data, then write the immutable Bronze raw fetch before parsing.
    const fetchResult = await fetchWithFallback(source, options);
    rawData = fetchResult.data;
    fromCache = fetchResult.fromCache;

    if (fromCache) {
      status = 'degraded_cache';
      errorMessage = fetchResult.error?.message || 'Upstream unavailable: Serving from last-known-good cache';
    }

    rawFetch = saveRawFetch({
      source,
      runId,
      rawPayload: rawData,
      fetchedAt: startedAt
    });

    // 2. Transform Bronze into canonical Silver candidates and validate contracts.
    const parseResult = parseAndValidate(rawFetch.data, source, { runId, now: startedAt });
    saveFailedRecords(parseResult.failedRecords, { source, runId, rawFetchId: rawFetch.id });

    itemsFetched = parseResult.itemsFetched;
    parsedJobsForCursor = parseResult.validJobs;
    const processableJobs = filterIncrementalJobs(parseResult.validJobs, source, options);
    itemsParsed = processableJobs.length;
    itemsSkipped = parseResult.itemsSkipped;
    driftDetails = parseResult.driftDetails;

    // 3. Populate Silver from Bronze-derived jobs.
    if (processableJobs.length > 0) {
      const dbResult = upsertJobs(processableJobs, {
        runId,
        rawFetchId: rawFetch.id,
        confirmedAt: startedAt
      });
      itemsInserted = dbResult.inserted;
      itemsDeduped = dbResult.deduped + dbResult.fuzzyMerged;
      itemsUpdated = dbResult.updated;
      itemsUnchanged = dbResult.unchanged;
      reviewQueued = dbResult.reviewQueued;

      if (!fromCache && !options.simulateDrift) {
        saveRawCache(source.id, rawFetch.data, parseResult.validJobs.length, null, runId);
      }
    }

    if (!fromCache) {
      const staleResult = markMissingJobsStale(
        source.id,
        parseResult.validJobs.map(job => job.source_record_key),
        {
          runId,
          staleAfterRuns: options.staleAfterRuns || 3,
          checkedAt: startedAt
        }
      );
      itemsStale = staleResult.staled;
    }

  } catch (err) {
    // Plan B: If live data fails or drifts, attempt recovery using last-known-good cache
    const cached = !fromCache ? getRawCache(source.id) : null;
    if (cached && !options.simulateDrift) {
      try {
        rawFetch = saveRawFetch({
          source,
          runId,
          rawPayload: cached.data,
          fetchedAt: startedAt
        });
        const parseResult = parseAndValidate(rawFetch.data, source, { runId, now: startedAt });
        saveFailedRecords(parseResult.failedRecords, { source, runId, rawFetchId: rawFetch.id });
        if (parseResult.validJobs.length > 0) {
          const dbResult = upsertJobs(parseResult.validJobs, {
            runId,
            rawFetchId: rawFetch.id,
            confirmedAt: startedAt
          });
          itemsInserted = dbResult.inserted;
          itemsDeduped = dbResult.deduped + dbResult.fuzzyMerged;
          itemsUpdated = dbResult.updated;
          itemsUnchanged = dbResult.unchanged;
          reviewQueued = dbResult.reviewQueued;
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
        if (err instanceof SchemaDriftError) {
          saveFailedRecords(err.details?.failedRecords || [], { source, runId, rawFetchId: rawFetch?.id });
        }
        itemsSkipped = err.details?.skippedCount || itemsFetched;
      }
    } else {
      if (err instanceof SchemaDriftError) {
        status = 'drift_error';
        errorMessage = err.message;
        driftDetails = err.details;
        saveFailedRecords(err.details?.failedRecords || [], { source, runId, rawFetchId: rawFetch?.id });
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
    id: runId,
    source_id: source.id,
    source_name: source.name,
    source_tier: source.tier,
    status,
    from_cache: fromCache,
    items_fetched: itemsFetched,
    items_parsed: itemsParsed,
    items_inserted: itemsInserted,
    items_deduped: itemsDeduped,
    items_updated: itemsUpdated,
    items_unchanged: itemsUnchanged,
    items_skipped: itemsSkipped,
    items_stale: itemsStale,
    review_queued: reviewQueued,
    error_message: errorMessage,
    drift_details: driftDetails,
    duration_ms: durationMs,
    started_at: startedAt,
    completed_at: completedAt
  };

  const loggedRunId = logRun(runData);

  if (status === 'success') {
    recordSourceSuccess(source.id, {
      completedAt,
      lastSeenAt: maxPostedAt(parsedJobsForCursor, completedAt)
    });
  } else if (['fetch_error', 'drift_error', 'degraded_cache'].includes(status)) {
    recordSourceFailure(source.id, {
      status,
      completedAt,
      circuitThreshold: options.circuitThreshold || 3,
      cooldownBaseMs: options.cooldownBaseMs || 60000
    });
  }

  return {
    runId: loggedRunId,
    sourceId: source.id,
    sourceName: source.name,
    sourceTier: source.tier,
    status,
    fromCache,
    itemsFetched,
    itemsParsed,
    itemsInserted,
    itemsDeduped,
    itemsUpdated,
    itemsUnchanged,
    itemsSkipped,
    itemsStale,
    reviewQueued,
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
