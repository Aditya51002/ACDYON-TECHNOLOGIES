import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setDb, getDb, closeDb, upsertJobs } from '../src/db.js';
import { startServer } from '../src/server.js';

let serverInstance;
const TEST_PORT = 3198;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

before(async () => {
  const memDb = new DatabaseSync(':memory:');
  setDb(memDb);
  getDb();

  // Seed test job
  upsertJobs([
    {
      id: 'job_test_1',
      content_hash: 'hash_test_12345',
      title: 'Full Stack Engineer',
      company: 'Antigravity Systems',
      location: 'Remote',
      is_remote: true,
      job_type: 'Full-time',
      category: 'Engineering',
      url: 'https://example.com/job1',
      salary_min: 150000,
      salary_max: 200000,
      salary_currency: 'USD',
      description: 'Building next generation AI systems',
      tags: ['TypeScript', 'Node.js', 'React'],
      source_id: 'test_src',
      source_name: 'Test Source',
      source_tier: 1
    }
  ]);

  serverInstance = await startServer(TEST_PORT);
});

after(() => {
  if (serverInstance) {
    serverInstance.close();
  }
  closeDb();
});

test('API - GET /health returns status healthy and database info', async () => {
  const res = await fetch(`${BASE_URL}/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'healthy');
  assert.ok(data.pipeline);
  assert.equal(data.pipeline.total_active_jobs, 1);
});

test('API - GET /jobs returns jobs with pagination and filters', async () => {
  const res = await fetch(`${BASE_URL}/jobs?search=Antigravity`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.success, true);
  assert.equal(json.data.length, 1);
  assert.equal(json.data[0].company, 'Antigravity Systems');
  assert.equal(json.pagination.total, 1);
});

test('API - GET /jobs/:id returns single job detail', async () => {
  const res = await fetch(`${BASE_URL}/jobs/job_test_1`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.success, true);
  assert.equal(json.data.title, 'Full Stack Engineer');
});

test('API - GET /api/metrics returns pipeline metrics', async () => {
  const res = await fetch(`${BASE_URL}/api/metrics`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.success, true);
  assert.ok(json.data.totalJobs >= 1);
});
