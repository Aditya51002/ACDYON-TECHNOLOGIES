import test from 'node:test';
import assert from 'node:assert/strict';
import { runSource } from '../src/pipeline.js';
import { getDb, queryJobs, closeDb, setDb, queryRuns } from '../src/db.js';
import { DatabaseSync } from 'node:sqlite';

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
});
