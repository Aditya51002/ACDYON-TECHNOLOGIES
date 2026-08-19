import crypto from 'node:crypto';
import {
  SCHEMA_VERSION,
  calculateCompletenessScore,
  normalizeSalaryToUsd,
  toUtcIso,
  validateCanonicalJob
} from './schema.js';

export class SchemaDriftError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SchemaDriftError';
    this.details = details;
  }
}

export function generateContentHash({ company, title, location, description = '' }) {
  const locStr = typeof location === 'string' ? location : (location?.name || String(location || ''));
  const normCompany = (company || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
  const normTitle = (title || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
  const normLocation = locStr.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
  const normDesc = (description || '').toLowerCase().replace(/<[^>]*>/g, '').trim().slice(0, 300).replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(`${normCompany}|${normTitle}|${normLocation}|${normDesc}`).digest('hex');
}

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

function checkIsRemote(locationStr = '', titleStr = '') {
  const combined = `${locationStr} ${titleStr}`.toLowerCase();
  return combined.includes('remote') || combined.includes('anywhere') || combined.includes('work from home') || combined.includes('telecommute');
}

function extractTags(text, explicitTags = []) {
  const tagsSet = new Set(explicitTags.filter(Boolean).map(tag => String(tag).trim()).filter(Boolean));
  const commonTech = [
    'React', 'Node.js', 'TypeScript', 'JavaScript', 'Python', 'Go', 'Golang',
    'Rust', 'Java', 'Kotlin', 'Swift', 'C++', 'C#', '.NET', 'Ruby', 'Rails',
    'AWS', 'GCP', 'Azure', 'Kubernetes', 'Docker', 'PostgreSQL', 'MySQL',
    'MongoDB', 'Redis', 'GraphQL', 'Next.js', 'Tailwind', 'Vue', 'Angular',
    'AI', 'Machine Learning', 'LLM', 'DevOps', 'Frontend', 'Backend', 'Full Stack'
  ];

  const lower = (text || '').toLowerCase();
  for (const tech of commonTech) {
    if (lower.includes(tech.toLowerCase())) {
      tagsSet.add(tech);
    }
  }

  return Array.from(tagsSet).slice(0, 10);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function currencyOrNull(value) {
  if (!value) return null;
  const normalized = String(value).trim().toUpperCase();
  if (normalized === '$') return 'USD';
  if (normalized === '\u20ac') return 'EUR';
  if (normalized === '\u00a3') return 'GBP';
  return normalized.length === 3 ? normalized : null;
}

function sourceRecordKey(sourceConfig, item) {
  const stableValue = item.external_id || item.url || generateContentHash(item);
  return crypto.createHash('sha256').update(`${sourceConfig.id}|${stableValue}`).digest('hex');
}

function parseGreenhouse(raw, sourceConfig) {
  const items = Array.isArray(raw?.jobs) ? raw.jobs : (Array.isArray(raw) ? raw : []);
  const companyName = sourceConfig.name.replace(/^Greenhouse\s*-\s*/i, '').trim();

  return items.map(item => {
    if (!item || typeof item !== 'object') return null;
    const title = item.title;
    const location = item.location?.name || 'Remote';
    const dept = item.departments?.[0]?.name || item.metadata?.find(meta => meta.name === 'Department')?.value || 'Engineering';

    return {
      external_id: String(item.id || item.internal_job_id || ''),
      title,
      company: companyName || item.company_name || 'Direct ATS',
      location,
      is_remote: checkIsRemote(location, title),
      job_type: 'Full-time',
      category: dept,
      url: item.absolute_url || item.url,
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      salary_raw: null,
      description: cleanText(item.content || item.notes || ''),
      tags: extractTags(`${title} ${dept}`, [dept]),
      posted_at: item.updated_at
    };
  });
}

function parseLever(raw, sourceConfig) {
  const items = Array.isArray(raw) ? raw : (Array.isArray(raw?.postings) ? raw.postings : []);
  const companyName = sourceConfig.name.replace(/^Lever\s*-\s*/i, '').trim();

  return items.map(item => {
    if (!item || typeof item !== 'object') return null;
    const title = item.text || item.title;
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
      url: item.hostedUrl || item.applyUrl || item.url,
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      salary_raw: item.salaryDescription || null,
      description: cleanText(item.descriptionPlain || item.description || ''),
      tags: extractTags(`${title} ${dept}`, [dept, commitment]),
      posted_at: item.createdAt
    };
  });
}

function parseAshby(raw, sourceConfig) {
  const items = Array.isArray(raw?.jobs) ? raw.jobs : (Array.isArray(raw) ? raw : []);
  const companyName = sourceConfig.name.replace(/^Ashby\s*-\s*/i, '').trim();

  return items.map(item => {
    if (!item || typeof item !== 'object') return null;
    const title = item.title;
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
      url: item.jobUrl || item.applyUrl,
      salary_min: numberOrNull(item.compensation?.targetSalary?.min),
      salary_max: numberOrNull(item.compensation?.targetSalary?.max),
      salary_currency: currencyOrNull(item.compensation?.targetSalary?.currency || 'USD'),
      salary_raw: item.compensation?.summary || null,
      description: cleanText(item.descriptionHtml || item.descriptionPlain || ''),
      tags: extractTags(`${title} ${dept}`, [dept]),
      posted_at: item.publishedAt
    };
  });
}

function parseRemoteOK(raw) {
  let items = Array.isArray(raw) ? raw : [];
  if (items.length > 0 && !items[0].position && !items[0].title) {
    items = items.slice(1);
  }

  return items.map(item => {
    if (!item || typeof item !== 'object') return null;
    const title = item.position || item.title;
    const tags = Array.isArray(item.tags) ? item.tags : [];
    return {
      external_id: String(item.id || ''),
      title,
      company: item.company || item.company_name,
      location: item.location || 'Worldwide Remote',
      is_remote: true,
      job_type: 'Full-time',
      category: tags[0] || 'Engineering',
      url: item.url || (item.id ? `https://remoteok.com/remote-jobs/${item.id}` : null),
      salary_min: numberOrNull(item.salary_min),
      salary_max: numberOrNull(item.salary_max),
      salary_currency: 'USD',
      salary_raw: item.salary_min && item.salary_max ? `$${item.salary_min} - $${item.salary_max}` : null,
      description: cleanText(item.description || ''),
      tags: extractTags(`${title} ${item.description || ''}`, tags),
      posted_at: item.date || item.epoch
    };
  });
}

function parseArbeitnow(raw) {
  const items = Array.isArray(raw?.data) ? raw.data : (Array.isArray(raw) ? raw : []);

  return items.map(item => {
    if (!item || typeof item !== 'object') return null;
    const title = item.title;
    const tags = Array.isArray(item.tags) ? item.tags : [];
    const jobTypes = Array.isArray(item.job_types) ? item.job_types.join(', ') : (item.job_types || 'Full-time');

    return {
      external_id: String(item.slug || item.id || ''),
      title,
      company: item.company_name,
      location: item.location || (item.remote ? 'Remote' : 'Europe'),
      is_remote: Boolean(item.remote || checkIsRemote(item.location, title)),
      job_type: jobTypes,
      category: tags[0] || 'Tech',
      url: item.url,
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      salary_raw: null,
      description: cleanText(item.description || ''),
      tags: extractTags(`${title} ${item.description || ''}`, tags),
      posted_at: item.created_at
    };
  });
}

function parseJobicy(raw) {
  const items = Array.isArray(raw?.jobs) ? raw.jobs : (Array.isArray(raw) ? raw : []);

  return items.map(item => {
    if (!item || typeof item !== 'object') return null;
    const title = item.jobTitle || item.title;
    return {
      external_id: String(item.id || ''),
      title,
      company: item.companyName || item.company,
      location: item.jobGeo || 'Anywhere',
      is_remote: true,
      job_type: item.jobType || 'Full-time',
      category: item.jobCategory || 'Tech',
      url: item.url,
      salary_min: numberOrNull(item.annualSalaryMin),
      salary_max: numberOrNull(item.annualSalaryMax),
      salary_currency: currencyOrNull(item.salaryCurrency || 'USD'),
      salary_raw: item.annualSalaryMin && item.annualSalaryMax ? `${item.salaryCurrency || '$'}${item.annualSalaryMin} - ${item.annualSalaryMax}` : null,
      description: cleanText(item.jobDescription || item.jobExcerpt || ''),
      tags: extractTags(`${title} ${item.jobExcerpt || ''}`, [item.jobCategory]),
      posted_at: item.pubDate
    };
  });
}

function parseGenericJson(raw) {
  let items = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (raw && typeof raw === 'object') {
    items = raw.jobs || raw.data || raw.listings || raw.results || raw.postings || [];
    if (!Array.isArray(items)) items = [raw];
  }

  const knownInputKeys = new Set([
    'id', 'slug', 'guid', 'title', 'position', 'role', 'job_title', 'name',
    'company', 'company_name', 'employer', 'url', 'link', 'apply_url', 'job_url',
    'absolute_url', 'location', 'city', 'remote', 'is_remote', 'type', 'job_type',
    'employment_type', 'category', 'department', 'salary_min', 'salary_max',
    'salary_currency', 'currency', 'salary', 'salary_raw', 'description', 'summary',
    'snippet', 'tags', 'posted_at', 'created_at', 'date'
  ]);

  return items.map(item => {
    if (!item || typeof item !== 'object') return null;
    const title = String(item.title || item.position || item.role || item.job_title || item.name || '').trim();
    const company = item.company && String(item.company).trim()
      ? String(item.company).trim()
      : (item.company_name && String(item.company_name).trim()
        ? String(item.company_name).trim()
        : (item.employer ? String(item.employer).trim() : null));
    const location = item.location || item.city || (item.remote ? 'Remote' : 'Worldwide');
    const extras = Object.fromEntries(Object.entries(item).filter(([key]) => !knownInputKeys.has(key)));

    return {
      external_id: String(item.id || item.slug || item.guid || ''),
      title,
      company,
      location,
      is_remote: Boolean(item.remote || item.is_remote || checkIsRemote(location, title)),
      job_type: item.type || item.job_type || item.employment_type || 'Full-time',
      category: item.category || item.department || 'Tech',
      url: item.url || item.link || item.apply_url || item.job_url || item.absolute_url,
      salary_min: numberOrNull(item.salary_min),
      salary_max: numberOrNull(item.salary_max),
      salary_currency: currencyOrNull(item.salary_currency || item.currency),
      salary_raw: item.salary || item.salary_raw || null,
      description: cleanText(item.description || item.summary || item.snippet || ''),
      tags: extractTags(`${title} ${item.description || ''}`, Array.isArray(item.tags) ? item.tags : []),
      posted_at: item.posted_at || item.created_at || item.date,
      ...extras
    };
  });
}

function parseBySourceType(rawData, sourceConfig) {
  switch (sourceConfig.type) {
    case 'ats_greenhouse':
      return parseGreenhouse(rawData, sourceConfig);
    case 'ats_lever':
      return parseLever(rawData, sourceConfig);
    case 'ats_ashby':
      return parseAshby(rawData, sourceConfig);
    case 'public_api_remoteok':
    case 'remoteok':
      return parseRemoteOK(rawData, sourceConfig);
    case 'public_api_arbeitnow':
    case 'arbeitnow':
      return parseArbeitnow(rawData, sourceConfig);
    case 'public_api_jobicy':
    case 'jobicy':
      return parseJobicy(rawData, sourceConfig);
    default:
      return parseGenericJson(rawData, sourceConfig);
  }
}

function makeCanonicalJob(item, sourceConfig, { now, runId }) {
  const location = typeof item.location === 'string' ? item.location : (item.location?.name || String(item.location || 'Remote'));
  const jobType = typeof item.job_type === 'string' ? item.job_type : (Array.isArray(item.job_type) ? item.job_type.join(', ') : 'Full-time');
  const category = typeof item.category === 'string' ? item.category : 'Tech';
  const postedAt = toUtcIso(item.posted_at, now);
  const salaryCurrency = currencyOrNull(item.salary_currency);
  const contentHash = generateContentHash({ ...item, location });
  const salaryUsd = normalizeSalaryToUsd({
    salary_min: item.salary_min,
    salary_max: item.salary_max,
    salary_currency: salaryCurrency
  });

  const baseJob = {
    ...item,
    id: `job_${contentHash.slice(0, 16)}`,
    content_hash: contentHash,
    source_record_key: sourceRecordKey(sourceConfig, { ...item, location }),
    external_id: item.external_id || null,
    title: item.title,
    company: item.company,
    location,
    is_remote: Boolean(item.is_remote),
    job_type: jobType,
    category,
    url: item.url,
    salary_min: item.salary_min,
    salary_max: item.salary_max,
    salary_currency: salaryCurrency,
    salary_raw: item.salary_raw || null,
    ...salaryUsd,
    description: item.description || '',
    tags: Array.isArray(item.tags) ? item.tags.map(tag => String(tag)) : [],
    source_id: sourceConfig.id,
    source_name: sourceConfig.name,
    source_tier: sourceConfig.tier || 2,
    posted_at: postedAt,
    ingested_at: now,
    run_id: runId || null,
    completeness_score: 0,
    schema_version: SCHEMA_VERSION
  };
  baseJob.completeness_score = calculateCompletenessScore(baseJob);
  return baseJob;
}

function failureReason(errors) {
  return errors.map(error => `${error.path || '<root>'}: ${error.message}`).join('; ');
}

export function validateJobItem(job) {
  return validateCanonicalJob(job).success;
}

export function parseAndValidate(rawData, sourceConfig, options = {}) {
  if (!rawData) {
    throw new SchemaDriftError(`Schema Drift: Received null or empty payload from ${sourceConfig.name}`, {
      sourceId: sourceConfig.id,
      receivedType: typeof rawData,
      expected: 'Non-empty array or JSON object',
      failedRecords: []
    });
  }

  const now = options.now || new Date().toISOString();
  const runId = options.runId || null;
  const rawCandidates = parseBySourceType(rawData, sourceConfig);
  const totalCandidates = rawCandidates.length;
  const sampleRawObj = Array.isArray(rawData) ? rawData[0] : (rawData.jobs?.[0] || rawData.data?.[0] || rawData);
  const sampleRawKeys = sampleRawObj && typeof sampleRawObj === 'object' ? Object.keys(sampleRawObj).slice(0, 15) : [];

  if (totalCandidates === 0) {
    throw new SchemaDriftError(`Schema Drift: Failed to extract any job items from source "${sourceConfig.name}". Upstream format may have changed.`, {
      sourceId: sourceConfig.id,
      sourceType: sourceConfig.type,
      totalCandidates: 0,
      sampleRawKeys,
      payloadType: Array.isArray(rawData) ? 'array' : typeof rawData,
      failedRecords: []
    });
  }

  const validJobs = [];
  const failedRecords = [];
  const safeEvolutionFields = new Set();

  for (const candidate of rawCandidates) {
    if (!candidate || typeof candidate !== 'object') {
      failedRecords.push({
        rawPayload: candidate,
        normalizedPayload: null,
        failureReason: 'Candidate did not normalize to an object'
      });
      continue;
    }

    const canonical = makeCanonicalJob(candidate, sourceConfig, { now, runId });
    const validation = validateCanonicalJob(canonical);
    for (const field of validation.safeEvolutionFields) safeEvolutionFields.add(field);

    if (validation.success) {
      validJobs.push(validation.data);
    } else {
      failedRecords.push({
        rawPayload: candidate,
        normalizedPayload: canonical,
        failureReason: failureReason(validation.errors)
      });
    }
  }

  const validCount = validJobs.length;
  const skippedCount = failedRecords.length;
  const failureRate = totalCandidates > 0 ? skippedCount / totalCandidates : 0;
  const driftDetails = {
    totalCandidates,
    validCount,
    skippedCount,
    failureRate: Number(failureRate.toFixed(2)),
    safeEvolutionFields: Array.from(safeEvolutionFields)
  };

  if (validCount === 0 || (totalCandidates >= 3 && failureRate >= 0.8)) {
    throw new SchemaDriftError(
      `Schema Drift Escalation: ${skippedCount}/${totalCandidates} items (${(failureRate * 100).toFixed(0)}%) failed contract validation from "${sourceConfig.name}". Halting ingestion to prevent database corruption.`,
      {
        sourceId: sourceConfig.id,
        sourceType: sourceConfig.type,
        totalReceived: totalCandidates,
        validCount,
        skippedCount,
        failureRate,
        sampleRawKeys,
        schemaVersion: SCHEMA_VERSION,
        failedRecords,
        requiredFields: ['title', 'company', 'url']
      }
    );
  }

  return {
    validJobs,
    failedRecords,
    itemsFetched: totalCandidates,
    itemsParsed: validCount,
    itemsSkipped: skippedCount,
    driftDetails: skippedCount > 0 || safeEvolutionFields.size > 0 ? driftDetails : null
  };
}
