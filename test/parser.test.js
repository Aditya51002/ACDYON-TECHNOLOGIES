import test from 'node:test';
import assert from 'node:assert/strict';
import { 
  parseAndValidate, 
  generateContentHash, 
  validateJobItem, 
  SchemaDriftError 
} from '../src/parser.js';

test('Parser - Content Hash generates identical hash for equivalent content', () => {
  const job1 = {
    company: 'Stripe, Inc.',
    title: 'Senior Backend Engineer',
    location: 'San Francisco, CA',
    description: '<p>Join our <b>Infrastructure</b> team.</p>'
  };

  const job2 = {
    company: 'Stripe Inc',
    title: 'senior backend engineer',
    location: 'San Francisco CA',
    description: 'Join our Infrastructure team.'
  };

  const hash1 = generateContentHash(job1);
  const hash2 = generateContentHash(job2);

  assert.equal(hash1, hash2, 'Normalized content should generate identical SHA-256 hash');
  assert.equal(hash1.length, 64, 'SHA-256 hash should be 64 characters hex');
});

test('Parser - Greenhouse normalizer parses valid payload', () => {
  const rawGreenhouse = {
    jobs: [
      {
        id: 12345,
        title: 'Full Stack Engineer',
        absolute_url: 'https://boards.greenhouse.io/figma/jobs/12345',
        location: { name: 'San Francisco, CA (Remote)' },
        departments: [{ name: 'Engineering' }],
        updated_at: '2026-08-01T12:00:00Z',
        content: '<p>Build collaborative design tools</p>'
      }
    ]
  };

  const sourceConfig = {
    id: 'greenhouse_figma',
    name: 'Greenhouse - Figma',
    type: 'ats_greenhouse',
    tier: 1
  };

  const result = parseAndValidate(rawGreenhouse, sourceConfig);
  assert.equal(result.itemsFetched, 1);
  assert.equal(result.itemsParsed, 1);
  assert.equal(result.itemsSkipped, 0);

  const job = result.validJobs[0];
  assert.equal(job.company, 'Figma');
  assert.equal(job.title, 'Full Stack Engineer');
  assert.equal(job.is_remote, true);
  assert.equal(job.category, 'Engineering');
  assert.ok(job.content_hash, 'Should have content_hash');
  assert.ok(job.tags.includes('Engineering'));
});

test('Parser - Skips individual malformed items without crashing', () => {
  const rawData = [
    { title: 'Valid Job 1', company: 'Acme Corp', url: 'https://example.com/job1' },
    { title: '', company: 'Acme Corp', url: 'https://example.com/job2' },
    { title: 'Valid Job 2', company: '', url: 'https://example.com/job3' },
    { title: 'Valid Job 3', company: 'Acme Corp', url: 'https://example.com/job4' }
  ];

  const sourceConfig = {
    id: 'test_generic',
    name: 'Test Source',
    type: 'generic',
    tier: 2
  };

  const result = parseAndValidate(rawData, sourceConfig);
  assert.equal(result.itemsFetched, 4);
  assert.equal(result.itemsParsed, 2);
  assert.equal(result.itemsSkipped, 2);
  assert.equal(result.validJobs.length, 2);
});

test('Parser - Escalates Loud SchemaDriftError when entire batch fails validation', () => {
  const corruptedPayload = [
    { random_column_a: 123, broken_field: 'unknown' },
    { random_column_b: 456, broken_field: 'unknown' }
  ];

  const sourceConfig = {
    id: 'hostile_source',
    name: 'Hostile Aggregator',
    type: 'generic',
    tier: 3
  };

  assert.throws(
    () => {
      parseAndValidate(corruptedPayload, sourceConfig);
    },
    (err) => {
      assert.ok(err instanceof SchemaDriftError);
      assert.match(err.message, /Schema Drift Escalation/);
      assert.equal(err.details.totalReceived, 2);
      assert.equal(err.details.validCount, 0);
      assert.equal(err.details.skippedCount, 2);
      return true;
    }
  );
});
