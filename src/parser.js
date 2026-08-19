import crypto from 'node:crypto';

/**
 * Custom Error for loud schema drift escalation
 */
export class SchemaDriftError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SchemaDriftError';
    this.details = details;
  }
}

/**
 * Generate a deterministic SHA-256 content hash for deduplication
 * @param {Object} job
 * @returns {string} SHA-256 hex string
 */
export function generateContentHash({ company, title, location, description = '' }) {
  const locStr = typeof location === 'string' ? location : (location?.name || String(location || ''));
  const normCompany = (company || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
  const normTitle = (title || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
  const normLocation = locStr.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
  // Sample first 300 chars of normalized text to avoid minor formatting differences
  const normDesc = (description || '').toLowerCase().replace(/<[^>]*>/g, '').trim().slice(0, 300).replace(/\s+/g, ' ');

  const hashInput = `${normCompany}|${normTitle}|${normLocation}|${normDesc}`;
  return crypto.createHash('sha256').update(hashInput).digest('hex');
}

/**
 * Strip HTML tags from strings
 */
function cleanText(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/gi, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .trim();
}

/**
 * Detect if a job is remote from text
 */
function checkIsRemote(locationStr = '', titleStr = '') {
  const combined = `${locationStr} ${titleStr}`.toLowerCase();
  return combined.includes('remote') || combined.includes('anywhere') || combined.includes('work from home') || combined.includes('telecommute');
}

/**
 * Extract tags/keywords from title and description
 */
function extractTags(text, explicitTags = []) {
  const tagsSet = new Set(explicitTags.map(t => String(t).trim()));
  const commonTech = [
    'React', 'Node.js', 'TypeScript', 'JavaScript', 'Python', 'Go', 'Golang',
    'Rust', 'Java', 'Kotlin', 'Swift', 'C++', 'C#', '.NET', 'Ruby', 'Rails',
    'AWS', 'GCP', 'Azure', 'Kubernetes', 'Docker', 'PostgreSQL', 'MySQL',
    'MongoDB', 'Redis', 'GraphQL', 'Next.js', 'Tailwind', 'Vue', 'Angular',
    'AI', 'Machine Learning', 'LLM', 'DevOps', 'Frontend', 'Backend', 'Full Stack'
  ];

  const lower = (text || '').toLowerCase();
  for (const tech of commonTech) {
    const techLower = tech.toLowerCase();
    if (lower.includes(techLower)) {
      tagsSet.add(tech);
    }
  }

  return Array.from(tagsSet).slice(0, 10);
}

/**
 * Normalizer: Greenhouse Public Boards API
 * Endpoint: https://boards-api.greenhouse.io/v1/boards/{board}/jobs
 */
function parseGreenhouse(raw, sourceConfig) {
  const items = Array.isArray(raw?.jobs) ? raw.jobs : (Array.isArray(raw) ? raw : []);
  const companyName = sourceConfig.name.replace(/^Greenhouse\s*-\s*/i, '').trim();

  return items.map(item => {
    if (!item || typeof item !== 'object') return null;
    const title = item.title;
    const url = item.absolute_url || item.url;
    const location = item.location?.name || 'Remote';
    const dept = item.departments?.[0]?.name || item.metadata?.find(m => m.name === 'Department')?.value || 'Engineering';

    return {
      external_id: String(item.id || item.internal_job_id || ''),
      title,
      company: companyName || item.company_name || 'Direct ATS',
      location,
      is_remote: checkIsRemote(location, title),
      job_type: 'Full-time',
      category: dept,
      url,
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      salary_raw: null,
      description: cleanText(item.content || item.notes || ''),
      tags: extractTags(`${title} ${dept}`, [dept]),
      posted_at: item.updated_at ? new Date(item.updated_at).toISOString() : new Date().toISOString()
    };
  });
}

/**
 * Normalizer: Lever Postings API
 * Endpoint: https://api.lever.co/v0/postings/{company}?mode=json
 */
function parseLever(raw, sourceConfig) {
  const items = Array.isArray(raw) ? raw : (Array.isArray(raw?.postings) ? raw.postings : []);
  const companyName = sourceConfig.name.replace(/^Lever\s*-\s*/i, '').trim();

  return items.map(item => {
    if (!item || typeof item !== 'object') return null;
    const title = item.text || item.title;
    const url = item.hostedUrl || item.applyUrl || item.url;
    const location = item.categories?.location || item.categories?.allLocations?.join(', ') || 'Remote';
    const dept = item.categories?.department || item.categories?.team || 'Engineering';
    const commitment = item.categories?.commitment || 'Full-time';

    return {
      external_id: String(item.id || ''),
      title,
      company: companyName || item.company || 'Direct ATS',
      location,
      is_remote: checkIsRemote(location, title) || item.workplaceType === 'remote',
      job_type: commitment,
      category: dept,
      url,
      salary_min: item.salaryDescription ? null : null,
      salary_max: null,
      salary_currency: null,
      salary_raw: item.salaryDescription || null,
      description: cleanText(item.descriptionPlain || item.description || ''),
      tags: extractTags(`${title} ${dept}`, [dept, commitment]),
      posted_at: item.createdAt ? new Date(item.createdAt).toISOString() : new Date().toISOString()
    };
  });
}

/**
 * Normalizer: Ashby Postings API
 * Endpoint: https://api.ashbyhq.com/posting-api/job-board/{company}
 */
function parseAshby(raw, sourceConfig) {
  const items = Array.isArray(raw?.jobs) ? raw.jobs : (Array.isArray(raw) ? raw : []);
  const companyName = sourceConfig.name.replace(/^Ashby\s*-\s*/i, '').trim();

  return items.map(item => {
    if (!item || typeof item !== 'object') return null;
    const title = item.title;
    const url = item.jobUrl || item.applyUrl;
    const location = item.location || (item.isRemote ? 'Remote' : 'Onsite');
    const dept = item.department || item.team || 'Engineering';

    return {
      external_id: String(item.id || ''),
      title,
      company: companyName || 'Direct ATS',
      location,
      is_remote: Boolean(item.isRemote || checkIsRemote(location, title)),
      job_type: item.employmentType || 'Full-time',
      category: dept,
      url,
      salary_min: item.compensation?.targetSalary?.min || null,
      salary_max: item.compensation?.targetSalary?.max || null,
      salary_currency: item.compensation?.targetSalary?.currency || 'USD',
      salary_raw: item.compensation?.summary || null,
      description: cleanText(item.descriptionHtml || item.descriptionPlain || ''),
      tags: extractTags(`${title} ${dept}`, [dept]),
      posted_at: item.publishedAt ? new Date(item.publishedAt).toISOString() : new Date().toISOString()
    };
  });
}

/**
 * Normalizer: RemoteOK Public API
 * Endpoint: https://remoteok.com/api
 */
function parseRemoteOK(raw, sourceConfig) {
  let items = Array.isArray(raw) ? raw : [];
  // RemoteOK first element is often legal disclaimer / metadata object without position
  if (items.length > 0 && !items[0].position && !items[0].title) {
    items = items.slice(1);
  }

  return items.map(item => {
    if (!item || typeof item !== 'object') return null;
    const title = item.position || item.title;
    const company = item.company || item.company_name;
    const url = item.url || (item.id ? `https://remoteok.com/remote-jobs/${item.id}` : null);
    const location = item.location || 'Worldwide Remote';
    const tags = Array.isArray(item.tags) ? item.tags : [];

    return {
      external_id: String(item.id || ''),
      title,
      company,
      location,
      is_remote: true,
      job_type: 'Full-time',
      category: tags[0] || 'Engineering',
      url,
      salary_min: item.salary_min ? Number(item.salary_min) : null,
      salary_max: item.salary_max ? Number(item.salary_max) : null,
      salary_currency: 'USD',
      salary_raw: item.salary_min && item.salary_max ? `$${item.salary_min} - $${item.salary_max}` : null,
      description: cleanText(item.description || ''),
      tags: extractTags(`${title} ${item.description || ''}`, tags),
      posted_at: item.date ? new Date(item.date).toISOString() : (item.epoch ? new Date(item.epoch * 1000).toISOString() : new Date().toISOString())
    };
  });
}

/**
 * Normalizer: Arbeitnow Public Job Board API
 * Endpoint: https://www.arbeitnow.com/api/job-board-api
 */
function parseArbeitnow(raw, sourceConfig) {
  const items = Array.isArray(raw?.data) ? raw.data : (Array.isArray(raw) ? raw : []);

  return items.map(item => {
    if (!item || typeof item !== 'object') return null;
    const title = item.title;
    const company = item.company_name;
    const url = item.url;
    const location = item.location || (item.remote ? 'Remote' : 'Europe');
    const tags = Array.isArray(item.tags) ? item.tags : [];
    const jobTypes = Array.isArray(item.job_types) ? item.job_types.join(', ') : (item.job_types || 'Full-time');

    return {
      external_id: String(item.slug || item.id || ''),
      title,
      company,
      location,
      is_remote: Boolean(item.remote || checkIsRemote(location, title)),
      job_type: jobTypes,
      category: tags[0] || 'Tech',
      url,
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      salary_raw: null,
      description: cleanText(item.description || ''),
      tags: extractTags(`${title} ${item.description || ''}`, tags),
      posted_at: item.created_at ? new Date(item.created_at * 1000).toISOString() : new Date().toISOString()
    };
  });
}

/**
 * Normalizer: Jobicy Public Remote Jobs API
 * Endpoint: https://jobicy.com/api/v2/remote-jobs
 */
function parseJobicy(raw, sourceConfig) {
  const items = Array.isArray(raw?.jobs) ? raw.jobs : (Array.isArray(raw) ? raw : []);

  return items.map(item => {
    if (!item || typeof item !== 'object') return null;
    const title = item.jobTitle || item.title;
    const company = item.companyName || item.company;
    const url = item.url;
    const location = item.jobGeo || 'Anywhere';

    return {
      external_id: String(item.id || ''),
      title,
      company,
      location,
      is_remote: true,
      job_type: item.jobType || 'Full-time',
      category: item.jobCategory || 'Tech',
      url,
      salary_min: item.annualSalaryMin ? Number(item.annualSalaryMin) : null,
      salary_max: item.annualSalaryMax ? Number(item.annualSalaryMax) : null,
      salary_currency: item.salaryCurrency || 'USD',
      salary_raw: item.annualSalaryMin && item.annualSalaryMax ? `${item.salaryCurrency || '$'}${item.annualSalaryMin} - ${item.annualSalaryMax}` : null,
      description: cleanText(item.jobDescription || ''),
      tags: extractTags(`${title} ${item.jobExcerpt || ''}`, [item.jobCategory]),
      posted_at: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString()
    };
  });
}

/**
 * Normalizer: Generic JSON Job Listings (Fallback & Custom Feeds)
 */
function parseGenericJson(raw, sourceConfig) {
  let items = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (raw && typeof raw === 'object') {
    items = raw.jobs || raw.data || raw.listings || raw.results || raw.postings || [];
    if (!Array.isArray(items)) {
      items = [raw];
    }
  }

  return items.map(item => {
    if (!item || typeof item !== 'object') return null;
    const title = (item.title || item.position || item.role || item.job_title || item.name || '').trim();
    const company = (item.company && item.company.trim()) ? item.company.trim() : ((item.company_name && item.company_name.trim()) ? item.company_name.trim() : (item.employer ? String(item.employer).trim() : null));
    const url = item.url || item.link || item.apply_url || item.job_url || item.absolute_url;
    const location = item.location || item.city || (item.remote ? 'Remote' : 'Worldwide');

    return {
      external_id: String(item.id || item.slug || item.guid || ''),
      title,
      company,
      location,
      is_remote: Boolean(item.remote || item.is_remote || checkIsRemote(location, title)),
      job_type: item.type || item.job_type || item.employment_type || 'Full-time',
      category: item.category || item.department || 'Tech',
      url,
      salary_min: item.salary_min ? Number(item.salary_min) : null,
      salary_max: item.salary_max ? Number(item.salary_max) : null,
      salary_currency: item.salary_currency || item.currency || null,
      salary_raw: item.salary || item.salary_raw || null,
      description: cleanText(item.description || item.summary || item.snippet || ''),
      tags: extractTags(`${title} ${item.description || ''}`, Array.isArray(item.tags) ? item.tags : []),
      posted_at: item.posted_at || item.created_at || item.date || new Date().toISOString()
    };
  });
}

/**
 * Validate normalized job item schema
 * Must have valid non-empty title, company, and url
 * @param {Object} job
 * @returns {boolean}
 */
export function validateJobItem(job) {
  if (!job || typeof job !== 'object') return false;
  if (!job.title || typeof job.title !== 'string' || job.title.trim().length < 2) return false;
  if (!job.company || typeof job.company !== 'string' || job.company.trim().length < 1) return false;
  if (!job.url || typeof job.url !== 'string' || job.url.trim().length < 4) return false;
  return true;
}

/**
 * Parse and normalize incoming raw data from a source.
 * Enforces schema-drift detection and generates deterministic deduplication content hashes.
 *
 * @param {any} rawData
 * @param {Object} sourceConfig
 * @returns {{ validJobs: Array<Object>, itemsFetched: number, itemsParsed: number, itemsSkipped: number, driftDetails: Object|null }}
 * @throws {SchemaDriftError} If batch schema drift is detected (100% failure or total malformed response)
 */
export function parseAndValidate(rawData, sourceConfig) {
  if (!rawData) {
    throw new SchemaDriftError(`Schema Drift: Received null or empty payload from ${sourceConfig.name}`, {
      sourceId: sourceConfig.id,
      receivedType: typeof rawData,
      expected: 'Non-empty array or JSON object'
    });
  }

  let rawCandidates = [];
  const type = sourceConfig.type;

  switch (type) {
    case 'ats_greenhouse':
      rawCandidates = parseGreenhouse(rawData, sourceConfig);
      break;
    case 'ats_lever':
      rawCandidates = parseLever(rawData, sourceConfig);
      break;
    case 'ats_ashby':
      rawCandidates = parseAshby(rawData, sourceConfig);
      break;
    case 'public_api_remoteok':
    case 'remoteok':
      rawCandidates = parseRemoteOK(rawData, sourceConfig);
      break;
    case 'public_api_arbeitnow':
    case 'arbeitnow':
      rawCandidates = parseArbeitnow(rawData, sourceConfig);
      break;
    case 'public_api_jobicy':
    case 'jobicy':
      rawCandidates = parseJobicy(rawData, sourceConfig);
      break;
    default:
      rawCandidates = parseGenericJson(rawData, sourceConfig);
      break;
  }

  const totalCandidates = rawCandidates.length;

  // Inspect raw sample keys for drift diagnostics
  const sampleRawObj = Array.isArray(rawData) ? rawData[0] : (rawData.jobs?.[0] || rawData.data?.[0] || rawData);
  const sampleRawKeys = sampleRawObj && typeof sampleRawObj === 'object' ? Object.keys(sampleRawObj).slice(0, 15) : [];

  // Check for 0 items parsed from non-empty payload
  if (totalCandidates === 0) {
    // If the payload was an object with unrecognized keys or unexpected structure
    throw new SchemaDriftError(`Schema Drift: Failed to extract any job items from source "${sourceConfig.name}". Upstream format may have changed.`, {
      sourceId: sourceConfig.id,
      sourceType: sourceConfig.type,
      totalCandidates: 0,
      sampleRawKeys,
      payloadType: Array.isArray(rawData) ? 'array' : typeof rawData
    });
  }

  const validJobs = [];
  let skippedCount = 0;
  const now = new Date().toISOString();

  for (const item of rawCandidates) {
    if (validateJobItem(item)) {
      const locStr = typeof item.location === 'string' ? item.location : (item.location?.name || String(item.location || 'Remote'));
      const jobTypeStr = typeof item.job_type === 'string' ? item.job_type : (Array.isArray(item.job_type) ? item.job_type.join(', ') : 'Full-time');
      const catStr = typeof item.category === 'string' ? item.category : 'Tech';

      const contentHash = generateContentHash({ ...item, location: locStr });
      validJobs.push({
        ...item,
        id: `job_${contentHash.slice(0, 16)}`,
        content_hash: contentHash,
        location: locStr,
        job_type: jobTypeStr,
        category: catStr,
        source_id: sourceConfig.id,
        source_name: sourceConfig.name,
        source_tier: sourceConfig.tier || 2,
        ingested_at: now
      });
    } else {
      skippedCount++;
    }
  }

  const validCount = validJobs.length;
  const failureRate = totalCandidates > 0 ? (skippedCount / totalCandidates) : 0;

  // LOUD Schema Drift Escalation:
  // If 100% of candidate items failed validation, or failure rate > 80% on batches >= 3
  if (validCount === 0 || (totalCandidates >= 3 && failureRate >= 0.8)) {
    throw new SchemaDriftError(
      `Schema Drift Escalation: ${skippedCount}/${totalCandidates} items (${(failureRate * 100).toFixed(0)}%) failed validation from "${sourceConfig.name}". Halting ingestion to prevent database corruption.`,
      {
        sourceId: sourceConfig.id,
        sourceType: sourceConfig.type,
        totalReceived: totalCandidates,
        validCount,
        skippedCount,
        failureRate,
        sampleRawKeys,
        requiredFields: ['title', 'company', 'url']
      }
    );
  }

  return {
    validJobs,
    itemsFetched: totalCandidates,
    itemsParsed: validCount,
    itemsSkipped: skippedCount,
    driftDetails: skippedCount > 0 ? {
      totalCandidates,
      validCount,
      skippedCount,
      failureRate: Number(failureRate.toFixed(2))
    } : null
  };
}
