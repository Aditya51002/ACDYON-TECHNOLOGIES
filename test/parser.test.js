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
  assert.equal(job.schema_version, '2.0.0');
  assert.ok(job.completeness_score > 0);
});

test('Parser - Safe schema evolution logs optional new fields and continues', () => {
  const rawData = [
    {
      id: 'safe_1',
      title: 'Platform Engineer',
      company: 'Acme Corp',
      location: 'Remote',
      url: 'https://example.com/jobs/safe-1',
      description: 'Build platform systems',
      unexpected_optional_field: 'new upstream metadata'
    }
  ];

  const result = parseAndValidate(rawData, {
    id: 'generic_safe',
    name: 'Generic Safe Feed',
    type: 'generic',
    tier: 2
  });

  assert.equal(result.itemsParsed, 1);
  assert.equal(result.itemsSkipped, 0);
  assert.deepEqual(result.driftDetails.safeEvolutionFields, ['unexpected_optional_field']);
  assert.equal(result.validJobs[0].unexpected_optional_field, 'new upstream metadata');
});

test('Parser - Breaking contract changes hard-fail the batch', () => {
  const rawData = [
    { id: 'broken_1', company: 'Acme Corp', url: 'https://example.com/jobs/broken-1' },
    { id: 'broken_2', title: 'Engineer', company: 'Acme Corp', url: 'notaurl' }
  ];

  assert.throws(
    () => parseAndValidate(rawData, {
      id: 'generic_breaking',
      name: 'Generic Breaking Feed',
      type: 'generic',
      tier: 2
    }),
    (err) => {
      assert.ok(err instanceof SchemaDriftError);
      assert.equal(err.details.validCount, 0);
      assert.equal(err.details.failedRecords.length, 2);
      assert.equal(err.details.schemaVersion, '2.0.0');
      return true;
    }
  );
});

test('Parser - Normalizes salary to annual USD fields', () => {
  const result = parseAndValidate([
    {
      id: 'salary_1',
      title: 'Data Engineer',
      company: 'EuroTech',
      location: 'Berlin',
      url: 'https://example.com/jobs/salary-1',
      salary_min: 100000,
      salary_max: 120000,
      salary_currency: 'EUR',
      salary_raw: 'EUR 100000 - 120000',
      description: 'Build data pipelines'
    }
  ], {
    id: 'salary_feed',
    name: 'Salary Feed',
    type: 'generic',
    tier: 2
  });

  const job = result.validJobs[0];
  assert.equal(job.salary_min_usd, 109000);
  assert.equal(job.salary_max_usd, 130800);
  assert.equal(job.salary_annual_usd, 119900);
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
    id: 'corrupted_feed',
    name: 'Corrupted Public Feed',
    type: 'generic',
    tier: 2
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

const dateCases = [
  {
    label: 'Greenhouse',
    source: { id: 'gh', name: 'Greenhouse - Acme', type: 'ats_greenhouse', tier: 1 },
    raw: {
      jobs: [{
        id: 1,
        title: 'Engineer',
        absolute_url: 'https://boards.greenhouse.io/acme/jobs/1',
        location: { name: 'Remote' },
        departments: [{ name: 'Engineering' }],
        updated_at: '2026-08-01T12:00:00-07:00',
        content: 'Build systems'
      }]
    },
    expected: '2026-08-01T19:00:00.000Z'
  },
  {
    label: 'Lever',
    source: { id: 'lever', name: 'Lever - Acme', type: 'ats_lever', tier: 1 },
    raw: [{
      id: 'lev_1',
      text: 'Engineer',
      hostedUrl: 'https://jobs.lever.co/acme/1',
      categories: { location: 'Remote', department: 'Engineering' },
      createdAt: '2026-08-01T00:30:00+05:30',
      descriptionPlain: 'Build systems'
    }],
    expected: '2026-07-31T19:00:00.000Z'
  },
  {
    label: 'Ashby',
    source: { id: 'ashby', name: 'Ashby - Acme', type: 'ats_ashby', tier: 1 },
    raw: {
      jobs: [{
        id: 'ash_1',
        title: 'Engineer',
        jobUrl: 'https://jobs.ashbyhq.com/acme/1',
        location: 'New York, NY',
        publishedAt: '2026-08-01T08:00:00-04:00',
        descriptionPlain: 'Build systems'
      }]
    },
    expected: '2026-08-01T12:00:00.000Z'
  },
  {
    label: 'RemoteOK',
    source: { id: 'remoteok', name: 'RemoteOK', type: 'public_api_remoteok', tier: 2 },
    raw: [{
      id: 1,
      position: 'Engineer',
      company: 'Acme',
      url: 'https://remoteok.com/remote-jobs/1',
      epoch: 1,
      description: 'Build systems'
    }],
    expected: '1970-01-01T00:00:01.000Z'
  },
  {
    label: 'Arbeitnow',
    source: { id: 'arbeitnow', name: 'Arbeitnow', type: 'public_api_arbeitnow', tier: 2 },
    raw: {
      data: [{
        slug: 'job-1',
        title: 'Engineer',
        company_name: 'Acme',
        url: 'https://www.arbeitnow.com/jobs/job-1',
        created_at: 1,
        description: 'Build systems'
      }]
    },
    expected: '1970-01-01T00:00:01.000Z'
  },
  {
    label: 'Jobicy',
    source: { id: 'jobicy', name: 'Jobicy', type: 'public_api_jobicy', tier: 2 },
    raw: {
      jobs: [{
        id: 'jobicy_1',
        jobTitle: 'Engineer',
        companyName: 'Acme',
        url: 'https://jobicy.com/jobs/job-1',
        pubDate: 'Sat, 01 Aug 2026 12:00:00 GMT',
        jobDescription: 'Build systems'
      }]
    },
    expected: '2026-08-01T12:00:00.000Z'
  },
  {
    label: 'Generic',
    source: { id: 'generic', name: 'Generic', type: 'generic', tier: 2 },
    raw: [{
      id: 'gen_1',
      title: 'Engineer',
      company: 'Acme',
      url: 'https://example.com/jobs/gen-1',
      posted_at: '2026-08-01T12:00:00',
      description: 'Build systems'
    }],
    expected: '2026-08-01T12:00:00.000Z'
  }
];

for (const dateCase of dateCases) {
  test(`Parser - ${dateCase.label} parser stores posted_at in UTC`, () => {
    const result = parseAndValidate(dateCase.raw, dateCase.source, {
      now: '2026-08-19T00:00:00.000Z'
    });
    assert.equal(result.validJobs[0].posted_at, dateCase.expected);
  });
}
