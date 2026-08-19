import test from 'node:test';
import assert from 'node:assert/strict';
import { runSource } from '../src/pipeline.js';
import {
  getDb,
  queryJobs,
  closeDb,
  setDb,
  queryRuns,
  seedSources,
  getSourceRuntimeState,
  getDedupReviewQueue,
  getFailedRecords
} from '../src/db.js';
import { DatabaseSync } from 'node:sqlite';

function mockFetchPayload(payload) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => payload
  });
}

function sourceConfig(overrides = {}) {
  return {
    id: overrides.id || 'mock_ats',
    name: overrides.name || 'Mock ATS',
    type: overrides.type || 'generic',
    tier: overrides.tier || 1,
    endpoint: overrides.endpoint || 'https://api.example.com/jobs',
    enabled: overrides.enabled ?? true,
    rate_limit_ms: overrides.rate_limit_ms || 0,
    supports_updated_at: overrides.supports_updated_at ?? false
  };
}

function snapshotDbState() {
  const db = getDb();
  return {
    rawFetches: db.prepare('SELECT source_id, run_id, raw_json FROM raw_fetches ORDER BY id').all(),
    jobs: db.prepare(`
      SELECT id, content_hash, source_record_key, title, company, location, url,
             first_seen_run_id, last_seen_run_id, is_active, is_stale
      FROM jobs
      ORDER BY id
    `).all(),
    runs: db.prepare(`
      SELECT id, status, items_fetched, items_parsed, items_inserted,
             items_deduped, items_updated, items_unchanged, items_skipped
      FROM runs
      ORDER BY id
    `).all()
  };
}

test.beforeEach(() => {
  // Use isolated in-memory DB for test isolation
  const memDb = new DatabaseSync(':memory:');
  setDb(memDb);
  getDb(); // Initializes schema in memory
});

test.afterEach(() => {
  closeDb();
});

test('Pipeline - Ingestion upserts new jobs and deduplicates existing jobs by content_hash', async () => {
  const mockJobsData = [
    {
      id: 'ext_1',
      title: 'Senior Frontend Engineer',
      company: 'Vercel',
      location: 'Remote',
      url: 'https://vercel.com/careers/1',
      category: 'Engineering',
      description: 'Build Next.js web applications'
    },
    {
      id: 'ext_2',
      title: 'Product Designer',
      company: 'Vercel',
      location: 'San Francisco',
      url: 'https://vercel.com/careers/2',
      category: 'Design',
      description: 'Design sleek user interfaces'
    }
  ];

  const sourceConfig = {
    id: 'mock_ats',
    name: 'Vercel Careers',
    type: 'generic',
    tier: 1,
    endpoint: 'https://api.vercel.com/jobs'
  };

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => mockJobsData
  });

  // First Run: Insert 2 jobs
  const run1 = await runSource(sourceConfig, { customFetch: mockFetch });
  assert.equal(run1.status, 'success');
  assert.equal(run1.itemsParsed, 2);
  assert.equal(run1.itemsInserted, 2);
  assert.equal(run1.itemsDeduped, 0);

  const jobsAfterRun1 = queryJobs();
  assert.equal(jobsAfterRun1.total, 2);

  // Second Run with same data: Should Deduplicate 2 jobs (0 new inserts)
  const run2 = await runSource(sourceConfig, { customFetch: mockFetch });
  assert.equal(run2.status, 'success');
  assert.equal(run2.itemsParsed, 2);
  assert.equal(run2.itemsInserted, 0);
  assert.equal(run2.itemsDeduped, 2);

  const jobsAfterRun2 = queryJobs();
  assert.equal(jobsAfterRun2.total, 2, 'Total unique jobs count must remain 2 after deduplication');
});

test('Pipeline - Bronze raw fetch feeds Silver jobs and Gold views', async () => {
  const payload = [
    {
      id: 'bsg_1',
      title: 'Staff Platform Engineer',
      company: 'Acme Systems',
      location: 'Remote',
      url: 'https://example.com/jobs/bsg-1',
      category: 'Engineering',
      salary_min: 150000,
      salary_max: 180000,
      salary_currency: 'USD',
      salary_raw: '$150000 - $180000',
      tags: ['Platform'],
      posted_at: '2026-08-01T12:00:00Z',
      description: 'Build resilient platform systems'
    }
  ];

  const source = sourceConfig({ id: 'bsg_source', name: 'BSG Source' });
  const run = await runSource(source, {
    runId: 'run_bsg',
    customFetch: mockFetchPayload(payload)
  });

  assert.equal(run.status, 'success');
  const db = getDb();
  const rawFetch = db.prepare('SELECT * FROM raw_fetches WHERE run_id = ?').get('run_bsg');
  assert.ok(rawFetch);
  assert.equal(rawFetch.raw_json, JSON.stringify(payload));

  const job = db.prepare('SELECT * FROM jobs WHERE source_id = ?').get('bsg_source');
  assert.equal(job.raw_fetch_id, rawFetch.id);
  assert.equal(job.first_seen_run_id, 'run_bsg');
  assert.ok(job.completeness_score >= 0.75);

  const goldDaily = db.prepare('SELECT * FROM jobs_by_company_daily WHERE company = ?').get('Acme Systems');
  assert.equal(goldDaily.job_count, 1);
  const highCompleteness = db.prepare('SELECT COUNT(*) AS total FROM high_completeness_jobs').get();
  assert.equal(highCompleteness.total, 1);
});

test('Pipeline - Idempotent run_id replay leaves DB state identical', async () => {
  const payload = [
    {
      id: 'idem_1',
      title: 'Backend Engineer',
      company: 'Idem Labs',
      location: 'Remote',
      url: 'https://example.com/jobs/idem-1',
      posted_at: '2026-08-01T12:00:00Z',
      description: 'Build APIs'
    }
  ];

  const source = sourceConfig({ id: 'idem_source', name: 'Idempotent Source' });
  const run1 = await runSource(source, {
    runId: 'run_idempotent_fixture',
    customFetch: mockFetchPayload(payload)
  });
  assert.equal(run1.status, 'success');
  const afterFirst = snapshotDbState();

  const run2 = await runSource(source, {
    runId: 'run_idempotent_fixture',
    customFetch: mockFetchPayload(payload)
  });
  assert.equal(run2.status, 'success');
  assert.equal(run2.replayed, true);

  assert.deepEqual(snapshotDbState(), afterFirst);
});

test('Pipeline - Incremental fetching only processes jobs newer than source cursor', async () => {
  const source = sourceConfig({
    id: 'incremental_source',
    name: 'Incremental Source',
    supports_updated_at: true
  });
  seedSources([source]);

  let payload = [
    {
      id: 'inc_old',
      title: 'Old Engineer',
      company: 'Cursor Corp',
      url: 'https://example.com/jobs/inc-old',
      posted_at: '2026-08-01T00:00:00Z',
      description: 'Old role'
    }
  ];

  await runSource(source.id, { customFetch: mockFetchPayload(payload) });
  assert.equal(getSourceRuntimeState(source.id).last_seen_at, '2026-08-01T00:00:00.000Z');

  payload = [
    payload[0],
    {
      id: 'inc_new',
      title: 'New Engineer',
      company: 'Cursor Corp',
      url: 'https://example.com/jobs/inc-new',
      posted_at: '2026-08-02T00:00:00Z',
      description: 'New role'
    }
  ];

  const run2 = await runSource(source.id, { customFetch: mockFetchPayload(payload) });
  assert.equal(run2.itemsFetched, 2);
  assert.equal(run2.itemsParsed, 1);
  assert.equal(run2.itemsInserted, 1);
  assert.equal(queryJobs({ source: source.id }).total, 2);
});

test('Pipeline - Missing jobs become stale after consecutive successful runs', async () => {
  const source = sourceConfig({ id: 'stale_source', name: 'Stale Source' });
  seedSources([source]);

  const jobA = {
    id: 'stale_a',
    title: 'Active Engineer',
    company: 'Stale Co',
    url: 'https://example.com/jobs/stale-a',
    posted_at: '2026-08-01T00:00:00Z',
    description: 'Still present'
  };
  const jobB = {
    id: 'stale_b',
    title: 'Stale Engineer',
    company: 'Stale Co',
    url: 'https://example.com/jobs/stale-b',
    posted_at: '2026-08-01T00:00:00Z',
    description: 'Will disappear'
  };

  await runSource(source.id, { customFetch: mockFetchPayload([jobA, jobB]), staleAfterRuns: 2 });
  await runSource(source.id, { customFetch: mockFetchPayload([jobA]), staleAfterRuns: 2 });
  const run3 = await runSource(source.id, { customFetch: mockFetchPayload([jobA]), staleAfterRuns: 2 });

  assert.equal(run3.itemsStale, 1);
  assert.equal(queryJobs({ source: source.id }).total, 1);
  const staleRow = getDb().prepare('SELECT is_stale, is_active FROM jobs WHERE external_id = ?').get('stale_b');
  assert.equal(staleRow.is_stale, 1);
  assert.equal(staleRow.is_active, 0);
});

test('Pipeline - High-confidence fuzzy duplicate auto-merges across sources', async () => {
  const firstSource = sourceConfig({ id: 'fuzzy_a', name: 'Fuzzy A' });
  const secondSource = sourceConfig({ id: 'fuzzy_b', name: 'Fuzzy B' });

  await runSource(firstSource, {
    customFetch: mockFetchPayload([{
      id: 'fuzzy_1',
      title: 'Senior Frontend Engineer',
      company: 'Acme',
      location: 'San Francisco, CA',
      url: 'https://example.com/jobs/fuzzy-1',
      posted_at: '2026-08-01T00:00:00Z',
      description: 'Build product UI'
    }])
  });

  const run2 = await runSource(secondSource, {
    customFetch: mockFetchPayload([{
      id: 'fuzzy_2',
      title: 'Senior Frontend Engineer',
      company: 'Acme',
      location: 'San Francisco, CA',
      url: 'https://example.org/jobs/fuzzy-2',
      posted_at: '2026-08-01T00:00:00Z',
      description: 'Build web interfaces'
    }])
  });

  assert.equal(run2.itemsDeduped, 1);
  assert.equal(queryJobs().total, 1);
});

test('Pipeline - Middle-band fuzzy duplicate queues review and keeps records separate', async () => {
  const firstSource = sourceConfig({ id: 'review_a', name: 'Review A' });
  const secondSource = sourceConfig({ id: 'review_b', name: 'Review B' });

  await runSource(firstSource, {
    customFetch: mockFetchPayload([{
      id: 'review_1',
      title: 'Senior Frontend Engineer',
      company: 'Acme',
      location: 'San Francisco, CA',
      url: 'https://example.com/jobs/review-1',
      posted_at: '2026-08-01T00:00:00Z',
      description: 'Build product UI'
    }])
  });

  const run2 = await runSource(secondSource, {
    customFetch: mockFetchPayload([{
      id: 'review_2',
      title: 'Senior Frontend Developer',
      company: 'Acme',
      location: 'San Francisco, CA',
      url: 'https://example.org/jobs/review-2',
      posted_at: '2026-08-01T00:00:00Z',
      description: 'Build web interfaces'
    }])
  });

  assert.equal(run2.reviewQueued, 1);
  assert.equal(queryJobs().total, 2);
  const reviewRows = getDedupReviewQueue();
  assert.equal(reviewRows.length, 1);
  assert.equal(reviewRows[0].decision_band, 'review');
});

test('Pipeline - Dead-letter queue persists malformed records', async () => {
  const source = sourceConfig({ id: 'dlq_source', name: 'DLQ Source' });

  const run = await runSource(source, {
    customFetch: mockFetchPayload([
      {
        id: 'dlq_valid',
        title: 'Valid Engineer',
        company: 'DLQ Co',
        url: 'https://example.com/jobs/dlq-valid',
        description: 'Valid role'
      },
      {
        id: 'dlq_invalid',
        title: '',
        company: 'DLQ Co',
        url: 'not-a-url'
      }
    ])
  });

  assert.equal(run.status, 'success');
  assert.equal(run.itemsSkipped, 1);
  const failed = getFailedRecords();
  assert.equal(failed.length, 1);
  assert.match(failed[0].failure_reason, /title|url/);
});

test('Pipeline - Circuit breaker skips during cooldown and retries after', async () => {
  const source = sourceConfig({ id: 'breaker_source', name: 'Breaker Source' });
  seedSources([source]);

  let calls = 0;
  const failingFetch = async () => {
    calls++;
    return {
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      headers: new Map()
    };
  };

  await runSource(source.id, {
    customFetch: failingFetch,
    maxAttempts: 1,
    circuitThreshold: 2,
    cooldownBaseMs: 1000
  });
  const secondFailure = await runSource(source.id, {
    customFetch: failingFetch,
    maxAttempts: 1,
    circuitThreshold: 2,
    cooldownBaseMs: 1000
  });
  assert.equal(secondFailure.status, 'fetch_error');
  assert.ok(getSourceRuntimeState(source.id).circuit_open_until);

  const skipped = await runSource(source.id, {
    customFetch: failingFetch,
    maxAttempts: 1,
    circuitThreshold: 2,
    cooldownBaseMs: 1000
  });
  assert.equal(skipped.status, 'skipped_circuit');
  assert.equal(calls, 2);

  getDb().prepare('UPDATE sources SET circuit_open_until = ? WHERE id = ?')
    .run('1970-01-01T00:00:00.000Z', source.id);

  const retried = await runSource(source.id, {
    customFetch: failingFetch,
    maxAttempts: 1,
    circuitThreshold: 2,
    cooldownBaseMs: 1000
  });
  assert.equal(retried.status, 'fetch_error');
  assert.equal(calls, 3);
});

test('Pipeline - Recovers gracefully from cache on simulated upstream failure', async () => {
  const mockJobsData = [
    {
      title: 'DevOps Engineer',
      company: 'Cloudflare',
      url: 'https://cloudflare.com/jobs/1'
    }
  ];

  const sourceConfig = {
    id: 'cache_test_src',
    name: 'Cloudflare ATS',
    type: 'generic',
    tier: 1,
    endpoint: 'https://api.cloudflare.com/jobs'
  };

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => mockJobsData
  });

  // Initial successful run primes the last-known-good cache
  await runSource(sourceConfig, { customFetch: mockFetch });

  // Second run with simulated failure should activate degraded_cache status
  const runFailed = await runSource(sourceConfig, { simulateFailure: true });
  assert.equal(runFailed.status, 'degraded_cache');
  assert.equal(runFailed.fromCache, true);
  assert.equal(runFailed.itemsParsed, 1);

  const runs = queryRuns();
  assert.equal(runs[0].status, 'degraded_cache');
  const runLog = getDb().prepare('SELECT status, from_cache FROM run_log ORDER BY started_at DESC LIMIT 1').get();
  assert.equal(runLog.status, 'degraded_cache');
  assert.equal(runLog.from_cache, 1);
});
