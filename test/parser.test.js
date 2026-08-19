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

test('Parser - LinkedIn Guest HTML normalizer parses live HTML card', () => {
  const rawLinkedInHtml = `
    <div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:998877">
      <h3 class="base-search-card__title">Senior Staff Engineer</h3>
      <h4 class="base-search-card__subtitle"><a href="https://linkedin.com/company/acme">Acme Cloud</a></h4>
      <span class="job-search-card__location">Remote, US</span>
      <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/senior-staff-engineer-998877?refId=123"></a>
    </div>
  `;

  const sourceConfig = {
    id: 'linkedin_guest_jobs',
    name: 'LinkedIn (Public Guest Jobs)',
    type: 'aggregator_linkedin',
    tier: 3
  };

  const result = parseAndValidate(rawLinkedInHtml, sourceConfig);
  assert.equal(result.itemsFetched, 1);
  assert.equal(result.itemsParsed, 1);
  assert.equal(result.validJobs[0].title, 'Senior Staff Engineer');
  assert.equal(result.validJobs[0].company, 'Acme Cloud');
  assert.equal(result.validJobs[0].url, 'https://www.linkedin.com/jobs/view/senior-staff-engineer-998877');
});

test('Parser - Wellfound normalizer parses startup listings', () => {
  const rawWellfound = [
    {
      id: 'wf_1',
      title: 'Founding Engineer (Rust / WebAssembly)',
      company: 'NextGen AI',
      location: 'San Francisco, CA',
      remote: true,
      salary_raw: '$160k - $200k • 0.5% Equity',
      url: 'https://wellfound.com/jobs/wf-1',
      tags: ['Rust', 'WebAssembly', 'AI']
    }
  ];

  const sourceConfig = {
    id: 'wellfound_startups',
    name: 'Wellfound Startups',
    type: 'aggregator_wellfound',
    tier: 3
  };

  const result = parseAndValidate(rawWellfound, sourceConfig);
  assert.equal(result.itemsFetched, 1);
  assert.equal(result.itemsParsed, 1);
  assert.equal(result.validJobs[0].title, 'Founding Engineer (Rust / WebAssembly)');
  assert.equal(result.validJobs[0].salary_raw, '$160k - $200k • 0.5% Equity');
});

test('Parser - Naukri normalizer parses India tech listings', () => {
  const rawNaukri = {
    jobDetails: [
      {
        jobId: 'nk_1',
        title: 'Lead Cloud Architect (AWS & Kubernetes)',
        companyName: 'Razorpay',
        staticUrl: '/job-listings-razorpay-lead-architect',
        placeholders: [
          { type: 'location', label: 'Bangalore / Bengaluru' },
          { type: 'salary', label: '₹40,00,000 - ₹55,00,000 PA' }
        ],
        tagsAndSkills: 'Kubernetes, AWS, Go, Microservices'
      }
    ]
  };

  const sourceConfig = {
    id: 'naukri_tech_jobs',
    name: 'Naukri Tech Jobs',
    type: 'aggregator_naukri',
    tier: 3
  };

  const result = parseAndValidate(rawNaukri, sourceConfig);
  assert.equal(result.itemsFetched, 1);
  assert.equal(result.itemsParsed, 1);
  assert.equal(result.validJobs[0].title, 'Lead Cloud Architect (AWS & Kubernetes)');
  assert.equal(result.validJobs[0].company, 'Razorpay');
  assert.equal(result.validJobs[0].location, 'Bangalore / Bengaluru');
  assert.equal(result.validJobs[0].url, 'https://www.naukri.com/job-listings-razorpay-lead-architect');
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
